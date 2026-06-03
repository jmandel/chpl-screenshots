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
const SYSTEM_INSTRUCTION = `Role:
You are a specialized medical data abstraction assistant. Your task is to analyze screenshots of Electronic Health Record (EHR) or Electronic Medical Record (EMR) interfaces and extract key administrative, patient, and session metadata into a structured JSON format.

Task Instructions:
1. Analyze the Screenshot: Examine the provided image of the clinical software interface.
2. Identify System Context:
   - Look for the main window title, header, or breadcrumbs to identify the active software function, form, or module (e.g., "Encounter Summary", "Progress Notes", "Patient Chart", "Order Entry").
   - Look for UI cues, terminology, or labels to identify the clinical specialty or department (e.g., "Cardiology", "Pediatrics", "General Practice").
   - Identify the software vendor/platform name if a logo, watermark, or brand name is visible; otherwise, record it as generic or unknown.
   - isEhrScreen (boolean): is this an EHR/clinical software screen at all (vs. marketing, login, generic/non-clinical UI)?
   - patientScope: "single" (one-patient chart/encounter), "multiple" (dashboard/worklist/schedule/list of several patients), or "none" (not about a patient — login, admin, marketing).
   - singlePatientConfidence (number 0.0-1.0): overall confidence this is an EHR screen about a SINGLE patient (isEhrScreen AND patientScope=single). High only when both clearly hold; multi-patient or non-EHR screens score low.
3. Extract Patient Demographics (usually shown together in a patient banner/header). Set each field's .value (or null if absent):
   - patientId: the unique medical record number ("ID", "MRN", "Pt ID", "Chart #", "Acct #").
   - fullName / firstName / lastName: the displayed patient name, parsed when possible.
   - dateOfBirth ("DOB"/"Born"/"Birth Date"), normalized YYYY-MM-DD; age as displayed ("45 y", "6 mo"); sex (M/F/Male/Female); genderIdentity/pronouns if shown separately.
   - Other banner demographics if visible: address, phone, maritalStatus, preferredLanguage, race, ethnicity.
4. Extract Encounter Details: encounterDate (normalize YYYY-MM-DD) and encounterType (visit type / encounter class / status).
5. Capture Additional Visible Fields (schema gaps):
   - For OTHER clearly-labeled data about the patient, provider/care team, or visit/encounter that has no slot above, add to "additionalFields": { category (patient|provider|encounter|order|other), label (on-screen field name e.g. "Insurance", "PCP", "Attending", "Room", "Allergies", "Chief Complaint"), value, box }.
   - Only include fields explicitly visible; do not invent. This is how we discover what to add to the schema next — be reasonably thorough.
6. BOUNDING BOXES (critical): EVERY extractable field is an object of the form { "value": <string|null>, "box": {ymin,xmin,ymax,xmax}|null }. For EVERY field whose value is NON-NULL you MUST also fill its "box": a tight rectangle around the on-screen text, integers normalized to a 0-1000 grid, origin TOP-LEFT (ymin/ymax vertical top->bottom, xmin/xmax horizontal left->right — the standard Gemini convention). If value is null, set box to null. Do not skip the box for any visible value.

Constraints & Quality Guidelines:
- Accuracy First: Only extract information explicitly visible in the image. Do not extrapolate, assume, or hallucinate.
- Null Values: If a field cannot be found with confidence, set its value to null (and box to null). Do not guess.
- Output Format: Return only a valid JSON object matching the schema. No conversational text.`;

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
    patient: {
      type: Type.OBJECT,
      description: "Patient demographic identifiers visible on screen.",
      properties: {
        patientId: field("The primary unique medical record identifier (MRN/Pt ID/Chart #)."),
        fullName: field("The patient's full name as displayed."),
        firstName: field("Patient first/given name."),
        lastName: field("Patient last/family name."),
        dateOfBirth: field("Patient date of birth, normalized to YYYY-MM-DD."),
        age: field("Age as displayed on screen, e.g. '45 y', '6 mo'."),
        sex: field("Administrative/legal sex as shown (e.g. M, F, Male, Female)."),
        genderIdentity: field("Gender identity or pronouns, if shown separately from sex."),
        address: field("Patient address if visible."),
        phone: field("Patient phone number if visible."),
        maritalStatus: field("Marital status if visible."),
        preferredLanguage: field("Preferred language if visible."),
        race: field("Race if visible."),
        ethnicity: field("Ethnicity if visible."),
      },
      required: ["patientId", "fullName"],
    },
    encounterContext: {
      type: Type.OBJECT,
      description: "Details about the specific patient visit or session shown.",
      properties: {
        encounterDate: field("The date of the encounter, normalized to YYYY-MM-DD."),
        encounterType: field("The classification of the visit or encounter type if labeled."),
      },
    },
    additionalFields: {
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
    },
  },
  required: ["systemMetadata", "patient", "additionalFields"],
};

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
export async function abstractScreenshot(imageArg: string): Promise<AbstractionResult> {
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

  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: "Abstract this EHR screenshot into the required JSON structure." },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error("Model returned no text content.");

  let parsed: any;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch (err) {
    throw new Error(
      `Failed to parse model output as JSON.\nRaw output:\n${raw}\n\nParse error: ${(err as Error).message}`,
    );
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
  const imageArg = process.argv[2];
  if (!imageArg) {
    throw new Error("Usage: bun run scripts/abstract-screenshot.ts <path-to-image>");
  }
  const { data } = await abstractScreenshot(imageArg);
  console.log(JSON.stringify(data, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
