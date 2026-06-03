/**
 * Why are patient identifiers under-detected? Test schema shape (typed array vs
 * flat fields) × thinking (off/on) × prompt emphasis, measuring identifier-capture
 * rate over a sample of single-patient screenshots.
 *
 * Usage: bun run scripts/id-experiment.ts [N=18]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { DATA_DIR } from "./chpl.ts";

const MODEL = "gemini-3.5-flash";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const fval = (x: any) => (x && typeof x === "object" && "value" in x ? x.value : x);
const box: Schema = { type: Type.OBJECT, nullable: true, properties: { ymin: { type: Type.INTEGER }, xmin: { type: Type.INTEGER }, ymax: { type: Type.INTEGER }, xmax: { type: Type.INTEGER } }, required: ["ymin", "xmin", "ymax", "xmax"] };
const field = (d: string): Schema => ({ type: Type.OBJECT, description: d, properties: { value: { type: Type.STRING, nullable: true, description: d }, box }, required: ["value"] });

const classifiers = {
  isEhrScreen: { type: Type.BOOLEAN },
  patientScope: { type: Type.STRING, enum: ["single", "multiple", "none"] },
  singlePatientConfidence: { type: Type.NUMBER },
};

// ARRAY: the current v3 identifiers[] shape
const ARRAY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    systemMetadata: { type: Type.OBJECT, properties: { activeFunction: field("active screen"), ...classifiers }, required: ["isEhrScreen", "patientScope", "singlePatientConfidence"] },
    patient: {
      type: Type.OBJECT,
      properties: {
        identifiers: { type: Type.ARRAY, description: "Every patient identifier in the banner.", items: { type: Type.OBJECT, properties: { type: { type: Type.STRING, enum: ["mrn", "chartNumber", "accountNumber", "ssn", "memberId", "external", "other"] }, value: { type: Type.STRING }, label: { type: Type.STRING, nullable: true }, masked: { type: Type.BOOLEAN }, box }, required: ["type", "value"] } },
        fullName: field("patient name"), dateOfBirth: field("DOB"),
      },
      required: ["identifiers"],
    },
  },
  required: ["systemMetadata", "patient"],
};

// FLAT: simple per-id fields
const FLAT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    systemMetadata: { type: Type.OBJECT, properties: { activeFunction: field("active screen"), ...classifiers }, required: ["isEhrScreen", "patientScope", "singlePatientConfidence"] },
    patient: {
      type: Type.OBJECT,
      properties: {
        mrn: field("Medical record number / patient ID / chart # shown in the banner."),
        accountNumber: field("Account/visit number if shown."),
        ssn: field("SSN if shown (keep masking)."),
        fullName: field("patient name"), dateOfBirth: field("DOB"),
      },
      required: ["fullName"],
    },
  },
  required: ["systemMetadata", "patient"],
};

const SYS_PLAIN = "Extract the EHR patient-identity banner as JSON. Capture system classifiers and the patient's identifiers and demographics shown in the header. Only what is visible; null if absent. Every value-bearing field is {value,box}; boxes normalized 0-1000.";
const SYS_STRONG = SYS_PLAIN + " IMPORTANT: patient ID numbers (MRN, Chart #, Account #, Pt ID) are small and easy to miss — scan the ENTIRE banner/header carefully and capture EVERY identifier number you can see.";

const VARIANTS = [
  { label: "array/think0", schema: ARRAY_SCHEMA, sys: SYS_PLAIN, think0: true },
  { label: "array/think-on", schema: ARRAY_SCHEMA, sys: SYS_PLAIN, think0: false },
  { label: "array/think0/strong", schema: ARRAY_SCHEMA, sys: SYS_STRONG, think0: true },
  { label: "flat/think0", schema: FLAT_SCHEMA, sys: SYS_PLAIN, think0: true },
  { label: "flat/think-on", schema: FLAT_SCHEMA, sys: SYS_PLAIN, think0: false },
];

function gotId(out: any, flat: boolean): boolean {
  if (flat) return [out.patient?.mrn, out.patient?.accountNumber, out.patient?.ssn].some((f) => fval(f) != null && fval(f) !== "");
  return Array.isArray(out.patient?.identifiers) && out.patient.identifiers.some((i: any) => i?.value);
}

function pickSinglePatient(n: number): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (const f of readdirSync(join(DATA_DIR, "abstractions")).filter((x) => x.endsWith(".ndjson"))) {
    for (const line of readFileSync(join(DATA_DIR, "abstractions", f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.output?.systemMetadata?.patientScope === "single" && !seen.has(r.file.split("/")[2])) {
          seen.add(r.file.split("/")[2]); out.push(join(DATA_DIR, "..", r.file));
        }
      } catch {}
    }
  }
  return out.slice(0, n);
}

async function main() {
  const N = Number(Bun.argv[2]) || 18;
  const imgs = pickSinglePatient(N);
  console.log(`${imgs.length} single-patient images × ${VARIANTS.length} variants = ${imgs.length * VARIANTS.length} calls\n`);
  const agg: Record<string, { got: number; ids: number; inTok: number; outTok: number; n: number }> = {};
  for (const v of VARIANTS) agg[v.label] = { got: 0, ids: 0, inTok: 0, outTok: 0, n: 0 };

  const tasks: { img: string; v: typeof VARIANTS[number] }[] = [];
  for (const img of imgs) for (const v of VARIANTS) tasks.push({ img, v });
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++; if (i >= tasks.length) return;
      const { img, v } = tasks[i];
      try {
        const b64 = readFileSync(img).toString("base64");
        const config: any = { systemInstruction: v.sys, responseMimeType: "application/json", responseSchema: v.schema, maxOutputTokens: 4096 };
        if (v.think0) config.thinkingConfig = { thinkingBudget: 0 };
        const resp = await ai.models.generateContent({ model: MODEL, contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: b64 } }, { text: "Extract per instructions." }] }], config });
        const out = JSON.parse((resp.text ?? "{}").replace(/^```json\s*|\s*```$/g, ""));
        const flat = v.schema === FLAT_SCHEMA;
        const a = agg[v.label];
        if (gotId(out, flat)) a.got++;
        a.ids += flat ? 0 : (out.patient?.identifiers?.length ?? 0);
        a.inTok += resp.usageMetadata?.promptTokenCount ?? 0; a.outTok += resp.usageMetadata?.candidatesTokenCount ?? 0; a.n++;
      } catch (e) { console.error(`  ${v.label}: ${(e as Error).message.slice(0, 60)}`); agg[v.label].n++; }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  const summary = VARIANTS.map((v) => {
    const a = agg[v.label];
    return { variant: v.label, idCaptureRate: `${Math.round((100 * a.got) / a.n)}% (${a.got}/${a.n})`, avgArrayIds: a.n ? Math.round((a.ids / a.n) * 10) / 10 : 0, avgInTok: Math.round(a.inTok / a.n), avgOutTok: Math.round(a.outTok / a.n) };
  });
  mkdirSync(join(DATA_DIR, "experiments", "id"), { recursive: true });
  writeFileSync(join(DATA_DIR, "experiments", "id", "results.json"), JSON.stringify(summary, null, 2));
  console.log("\n=== ID CAPTURE BY VARIANT ===");
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error("✗", e.message); process.exit(1); });
