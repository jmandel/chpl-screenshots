/**
 * abstract-screenshot.ts
 *
 * Usage: bun run scripts/abstract-screenshot.ts <path-to-image>
 *
 * Sends a single EHR screenshot to Google Gemini together with the abstraction
 * system prompt, constraining the output with a Gemini-compatible responseSchema,
 * and prints the structured JSON result.
 *
 * The API key is read from process.env.GEMINI_API_KEY (Bun auto-loads .env).
 */

import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { GoogleGenAI, Type, type Schema } from "@google/genai";

const MODEL_ID = "gemini-3.5-flash";

/**
 * System prompt for the abstraction agent.
 *
 * Mirrors the instruction text in abstraction-prompt.md. We keep it inline so the
 * script is self-contained and can be run from anywhere.
 */
// Default (cheap) prompt mirrors the experiment-winning config: data + boxes, no
// schema-gap discovery. Debug adds step 5 (additionalFields).
function buildInstruction(debug: boolean): string {
  return `Role:
You are a specialized medical data abstraction assistant. You analyze screenshots of EHR/EMR interfaces and extract the PATIENT-IDENTITY BANNER into structured JSON.

SCOPE — read carefully:
Extract only the "patient identity banner": the header/strip that says WHO the patient is and the immediate visit/provider context (identifiers, demographics, contact, light insurance, the provider(s) of record, and the active encounter). Do NOT extract clinical body content from the work area — problem lists, diagnoses/ICD codes, medications, allergies, vital signs, orders, results, notes — even when visible on screen. Those are out of scope.${debug ? " (Debug: you MAY note out-of-scope items in additionalFields, see step 6.)" : ""}

Task Instructions:
1. Analyze the screenshot.
2. Identify System Context:
   - systemName: the EHR vendor/platform/brand (logo/watermark/title) if visible.
   - clinicalSpecialty: specialty/department if evident (e.g. Cardiology, Pediatrics).
   - activeFunction: the active screen/module/form title; uiSection: the sub-panel/tab in focus.
   - isEhrScreen (bool): is this EHR/clinical software at all (vs. marketing, login, generic UI)?
   - patientScope: "single" / "multiple" / "none".
   - singlePatientConfidence (0.0-1.0): confidence this is an EHR screen about a SINGLE patient.
   - loggedInUser: the authenticated operator if shown ("Welcome X", "User: X", "Logged in: X"). IMPORTANT: this is whoever is OPERATING the software, NOT a patient provider. Never put this person in "providers".
3. Patient identity (the patient in view). Set each field's .value (or null if absent):
   - identifiers[]: capture EVERY patient identifier in the banner as a typed entry { type (mrn|chartNumber|accountNumber|ssn|memberId|external|other), value (as shown, keep masking like ***-**-6789), label (on-screen wording), masked (bool), box }. Banners often show several distinct IDs — capture them all.
   - primaryId: the single most prominent identifier (usually the MRN) as { type, value } (no box).
   - fullName / firstName / lastName; dateOfBirth (YYYY-MM-DD); age (as shown); sex (M/F/Male/Female).
   - phone, email, address (if in the banner).
   - insurance (light, if in the banner): primaryPayer, secondaryPayer, memberId, groupNumber. Do not hunt the billing screen — only what the banner shows.
4. Providers of record (providers[]): the care provider(s) named in the patient/visit banner, each { name, role (attending|rendering|referring|primaryCare|resident|nurse|consulting|other — use "other" if unlabeled), credential (MD/DO/NP/…), box }. Only banner providers — NOT every name in the chart, and NEVER the logged-in operator (that's loggedInUser).
5. Encounter context: encounterDate (YYYY-MM-DD), encounterType (visit type/class), location (facility/clinic/unit/room in the banner), visitId (CSN/FIN/Visit #).
${debug ? `6a. additionalFields (schema gaps): for OTHER clearly-labeled data — including out-of-scope clinical items (allergies, problems, meds, vitals) and anything else — add { category (patient|provider|encounter|order|other), label, value, box }. Only what is explicitly visible; this is for discovery.
` : ""}6. BOUNDING BOXES (critical): every value-bearing field is { "value": <string|null>, "box": {ymin,xmin,ymax,xmax}|null }, and every array entry (identifiers[], providers[]) carries its own "box". For EVERY value you extract you MUST fill its box: a tight rectangle around the on-screen text, integers normalized to a 0-1000 grid, origin TOP-LEFT (the standard Gemini convention). If a value is null, set its box to null.

Constraints:
- Accuracy first: only what is explicitly visible; do not extrapolate or hallucinate. Null when unsure.
- Stay in scope: banner identity/context only (no clinical body content${debug ? ", except additionalFields for discovery" : ""}).
- Output only a valid JSON object matching the schema. No conversational text.`;
}

/**
 * Gemini responseSchema (OpenAPI-3 subset), converted from the draft-07
 * "ClinicalSessionContext" schema in abstraction-prompt.md.
 *
 * Conversion deltas applied:
 *  - Dropped the "$schema" and "title" wrapper keys (unsupported).
 *  - Converted union types ["string","null"] -> { type: Type.STRING, nullable: true }.
 *  - Kept "required", "properties", "description".
 *  - Kept "format": "date" on encounterDate (supported as a STRING format hint).
 */
// A bounding box, normalized to a 0-1000 grid, origin top-left. Nullable so a
// field that isn't visible can omit it.
const boxSchema: Schema = {
  type: Type.OBJECT,
  nullable: true,
  description: "Tight rectangle around the value, integers normalized 0-1000, origin top-left. REQUIRED whenever value is non-null.",
  properties: {
    ymin: { type: Type.INTEGER },
    xmin: { type: Type.INTEGER },
    ymax: { type: Type.INTEGER },
    xmax: { type: Type.INTEGER },
  },
  required: ["ymin", "xmin", "ymax", "xmax"],
};

// Every extractable field is a { value, box } pair. Co-locating the box with the
// value forces the model to localize each value it extracts.
const field = (description: string): Schema => ({
  type: Type.OBJECT,
  description,
  properties: {
    value: { type: Type.STRING, nullable: true, description },
    box: boxSchema,
  },
  required: ["value"],
});

// v3: scoped to the PATIENT-IDENTITY BANNER (who is this patient + immediate
// visit/provider context). NOT clinical body content (problems, meds, allergies,
// vitals, orders) — those go to additionalFields only in --debug.
const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    systemMetadata: {
      type: Type.OBJECT,
      description: "Metadata about the software application and current interface state.",
      properties: {
        systemName: field("The brand or vendor name of the EHR platform if visible."),
        clinicalSpecialty: field("The medical specialty or clinical domain inferred from the interface."),
        activeFunction: field("The title of the active screen, module, form, or tab."),
        uiSection: field("Specific sub-panel, sub-tab, or widget currently in focus."),
        isEhrScreen: {
          type: Type.BOOLEAN,
          description: "True if this is an EHR/clinical software screen (vs. marketing, login, generic/non-clinical UI).",
        },
        patientScope: {
          type: Type.STRING,
          enum: ["single", "multiple", "none"],
          description: "single = one-patient context; multiple = dashboard/list of several patients; none = not about a patient.",
        },
        singlePatientConfidence: {
          type: Type.NUMBER,
          description: "0.0-1.0 confidence this is an EHR screen about a single patient (isEhrScreen AND patientScope=single).",
        },
      },
      required: ["activeFunction", "isEhrScreen", "patientScope", "singlePatientConfidence"],
    },
    // The authenticated operator (e.g. "Welcome Dr. Smith", "User: SysAdmin"). This
    // is whoever is logged in — NOT the patient's care provider.
    loggedInUser: field("Name of the logged-in user/operator (e.g. 'Welcome X', 'User: X'). The operator, NOT a patient provider."),
    patient: {
      type: Type.OBJECT,
      description: "Identity-banner facts about the single patient in view.",
      properties: {
        // All local identifiers shown in the banner (a screen often shows several).
        identifiers: {
          type: Type.ARRAY,
          description: "Every patient identifier shown in the banner. EHRs show many; capture each as a typed entry.",
          items: {
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING, enum: ["mrn", "chartNumber", "accountNumber", "ssn", "memberId", "external", "other"], description: "Normalized identifier type." },
              value: { type: Type.STRING, description: "The identifier value as shown (keep masking, e.g. ***-**-6789)." },
              label: { type: Type.STRING, nullable: true, description: "On-screen label, e.g. 'MRN', 'Chart #', 'Acct #'." },
              masked: { type: Type.BOOLEAN, description: "True if shown partially masked." },
              box: boxSchema,
            },
            required: ["type", "value"],
          },
        },
        primaryId: {
          type: Type.OBJECT,
          description: "The single most prominent identifier (usually the MRN), for convenience. No box (it duplicates an identifiers[] entry).",
          properties: {
            type: { type: Type.STRING, nullable: true },
            value: { type: Type.STRING, nullable: true },
          },
        },
        fullName: field("The patient's full name as displayed."),
        firstName: field("Patient first/given name."),
        lastName: field("Patient last/family name."),
        dateOfBirth: field("Patient date of birth, normalized to YYYY-MM-DD."),
        age: field("Age as displayed on screen, e.g. '45 y', '6 mo'."),
        sex: field("Administrative/legal sex as shown (e.g. M, F, Male, Female)."),
        phone: field("Patient phone number if shown in the banner."),
        email: field("Patient email if shown in the banner."),
        address: field("Patient address if shown in the banner."),
        insurance: {
          type: Type.OBJECT,
          description: "Light insurance/coverage if shown in the banner (not a full billing record).",
          properties: {
            primaryPayer: field("Primary insurance/payer/plan name."),
            secondaryPayer: field("Secondary insurance/payer name."),
            memberId: field("Insurance member/subscriber ID."),
            groupNumber: field("Insurance group number."),
          },
        },
      },
      required: ["identifiers"],
    },
    // Provider(s) of record shown in the banner — NOT every name in the chart.
    providers: {
      type: Type.ARRAY,
      description: "Care provider(s) shown in the patient/visit banner. Empty if none. Do NOT include the logged-in operator here.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "Provider name as shown." },
          role: { type: Type.STRING, enum: ["attending", "rendering", "referring", "primaryCare", "resident", "nurse", "consulting", "other"], description: "Role if indicated; 'other' if unlabeled." },
          credential: { type: Type.STRING, nullable: true, description: "e.g. MD, DO, NP, PA, RN." },
          box: boxSchema,
        },
        required: ["name", "role"],
      },
    },
    encounterContext: {
      type: Type.OBJECT,
      description: "Banner-level context about the specific visit (not clinical content).",
      properties: {
        encounterDate: field("The date of the encounter, normalized to YYYY-MM-DD."),
        encounterType: field("The classification of the visit/encounter type if labeled."),
        location: field("Facility / clinic / unit / room shown in the banner."),
        visitId: field("Encounter/visit/account number identifying this visit (e.g. CSN, FIN, Visit #)."),
      },
    },
  },
  required: ["systemMetadata", "patient"],
};

// additionalFields (schema-gap discovery) is requested only in debug mode.
const ADDITIONAL_FIELDS: Schema = {
  type: Type.ARRAY,
  description:
    "Other clearly-labeled patient/provider/visit data points visible on screen that the schema above does not capture. Used to discover schema gaps.",
  items: {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING, description: "One of: patient, provider, encounter, order, other." },
      label: { type: Type.STRING, description: "The on-screen field name/label, e.g. 'Insurance', 'PCP', 'Attending'." },
      value: { type: Type.STRING, description: "The displayed value for this field." },
      box: boxSchema,
    },
    required: ["category", "label", "value"],
  },
};

function buildSchema(debug: boolean): Schema {
  if (!debug) return responseSchema;
  return {
    ...responseSchema,
    properties: { ...(responseSchema.properties as any), additionalFields: ADDITIONAL_FIELDS },
    required: [...(responseSchema.required ?? []), "additionalFields"],
  };
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `Unsupported image extension "${ext}". Supported: ${Object.keys(MIME_BY_EXT).join(", ")}`,
    );
  }
  return mime;
}

/** Strip ```json ... ``` (or bare ``` ... ```) fences if the model added them. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fenceMatch ? fenceMatch[1] : trimmed).trim();
}

/** Parse model JSON; return undefined (not throw) so callers can retry. */
function tryParseJson(raw: string | undefined): any {
  if (!raw) return undefined;
  try { return JSON.parse(stripCodeFences(raw)); } catch { return undefined; }
}

/** Read pixel dimensions of an image via ffprobe (ffmpeg is already available). */
async function imageSize(filePath: string): Promise<{ width: number; height: number }> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-select_streams", "v:0",
     "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", filePath],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const [w, h] = out.split("x").map(Number);
  if (!w || !h) throw new Error(`Could not read image dimensions (ffprobe said: "${out}")`);
  return { width: w, height: h };
}

/**
 * Recursively attach a pixel-space `boxPx` next to every normalized `box` in the
 * result — covers every { value, box } field plus additionalFields entries.
 */
function addPixelBoxes(node: any, width: number, height: number): void {
  if (Array.isArray(node)) {
    for (const v of node) addPixelBoxes(v, width, height);
    return;
  }
  if (!node || typeof node !== "object") return;
  const b = node.box;
  if (b && typeof b.xmin === "number" && typeof b.ymin === "number") {
    const x = Math.round((b.xmin / 1000) * width);
    const y = Math.round((b.ymin / 1000) * height);
    node.boxPx = {
      x,
      y,
      width: Math.round((b.xmax / 1000) * width) - x,
      height: Math.round((b.ymax / 1000) * height) - y,
    };
  }
  for (const k of Object.keys(node)) {
    if (k === "box" || k === "boxPx") continue;
    addPixelBoxes(node[k], width, height);
  }
}

export interface AbstractionResult {
  model: string;
  data: any;
  imageSize: { width: number; height: number };
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Abstract a single EHR screenshot into structured JSON (with pixel-space
 * bounding boxes) and return the result plus token usage. Importable so batch
 * runners can reuse it.
 */
export async function abstractScreenshot(
  imageArg: string,
  opts: { debug?: boolean } = {},
): Promise<AbstractionResult> {
  const debug = opts.debug ?? false;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env or the environment (it is auto-loaded by Bun).",
    );
  }

  const imagePath = resolve(imageArg);
  const mimeType = inferMimeType(imagePath);
  const base64Data = readFileSync(imagePath).toString("base64");

  const ai = new GoogleGenAI({ apiKey });

  // Default (cheap) config from the optimization experiment: thinking OFF, no
  // additionalFields. Debug: thinking ON + additionalFields (schema-gap discovery).
  const contents = [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType, data: base64Data } },
        { text: "Abstract this EHR screenshot into the required JSON structure." },
      ],
    },
  ];
  // maxOutputTokens caps cost AND bounds the rare think=0 runaway (model spewing
  // a giant string to fill a field). Debug needs more room for additionalFields.
  const baseConfig: any = {
    systemInstruction: buildInstruction(debug),
    responseMimeType: "application/json",
    responseSchema: buildSchema(debug),
    maxOutputTokens: debug ? 8192 : 4096,
  };
  const callModel = (thinkingOff: boolean) =>
    ai.models.generateContent({
      model: MODEL_ID,
      contents,
      config: thinkingOff ? { ...baseConfig, thinkingConfig: { thinkingBudget: 0 } } : baseConfig,
    });

  // Default = thinking OFF (cheap). If the output won't parse — the rare
  // degenerate runaway under think=0 — retry once WITH thinking on, which
  // reliably recovers (verified: think=0 fails ~2/3 on the bad images; thinking on passes).
  let response = await callModel(!debug);
  let parsed = tryParseJson(response.text);
  if (parsed === undefined && !debug) {
    response = await callModel(false); // thinking on
    parsed = tryParseJson(response.text);
  }
  if (parsed === undefined) {
    throw new Error(`Failed to parse model output as JSON.\nRaw output:\n${response.text}`);
  }

  const size = await imageSize(imagePath);
  addPixelBoxes(parsed, size.width, size.height);

  const u: any = response.usageMetadata ?? {};
  return {
    model: MODEL_ID,
    data: parsed,
    imageSize: size,
    usage: {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: u.candidatesTokenCount ?? 0,
      totalTokens: u.totalTokenCount ?? 0,
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  const imageArg = args.find((a) => !a.startsWith("--"));
  if (!imageArg) {
    throw new Error("Usage: bun run scripts/abstract-screenshot.ts <path-to-image> [--debug]");
  }
  const { data } = await abstractScreenshot(imageArg, { debug });
  console.log(JSON.stringify(data, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
