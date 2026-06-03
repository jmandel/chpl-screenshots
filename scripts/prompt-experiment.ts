/**
 * Prompt/cost optimization experiment (≤100 Gemini calls).
 *
 * Question: how cheap can the abstraction get if we extract DATA ONLY — no
 * bounding boxes, no additionalFields/schema-gap capture — while still getting
 * patient demographics + EHR context? We also try shrinking the input image
 * (fewer input tokens) and terse output keys (fewer output tokens), and measure
 * how much accuracy (vs. the full v2 baseline) suffers, if at all.
 *
 * Output: data/experiments/prompt-opt/results.json + a printed summary.
 * Usage: bun run scripts/prompt-experiment.ts [numImages=12]
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { DATA_DIR } from "./chpl.ts";

const MODEL = "gemini-3.5-flash";
const RATE_IN = 1.5, RATE_OUT = 9.0; // $/1M tokens
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const fval = (x: any) => (x && typeof x === "object" && "value" in x ? x.value : x);
const norm = (v: any) => (v == null ? null : String(v).trim().toLowerCase().replace(/\s+/g, " "));

const P = (description: string): Schema => ({ type: Type.STRING, nullable: true, description });

// LEAN: data only, flat-ish, no boxes, no additionalFields.
const LEAN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    systemName: P("EHR/vendor/platform name if visible"),
    clinicalSpecialty: P("clinical specialty/department"),
    activeFunction: P("active screen/module/form title"),
    isEhrScreen: { type: Type.BOOLEAN },
    patientScope: { type: Type.STRING, enum: ["single", "multiple", "none"] },
    singlePatientConfidence: { type: Type.NUMBER },
    patient: {
      type: Type.OBJECT,
      properties: {
        patientId: P("MRN / patient identifier"),
        fullName: P("full name"), firstName: P("first name"), lastName: P("last name"),
        dateOfBirth: P("DOB YYYY-MM-DD"), age: P("age as shown"), sex: P("sex"),
      },
    },
    encounterDate: P("encounter date YYYY-MM-DD"),
    encounterType: P("visit/encounter type"),
  },
  required: ["isEhrScreen", "patientScope"],
};
const LEAN_SYS =
  "Extract EHR screenshot metadata as JSON. Capture: systemName, clinicalSpecialty, activeFunction; isEhrScreen (bool); patientScope (single|multiple|none); singlePatientConfidence (0-1); patient {patientId, fullName, firstName, lastName, dateOfBirth YYYY-MM-DD, age, sex}; encounterDate (YYYY-MM-DD); encounterType. Only what is explicitly visible; null if absent. Do not add bounding boxes or any other fields.";

// TERSE: short keys to shave output tokens.
const TERSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    sys: P("system/vendor name"), spec: P("specialty"), scr: P("active screen"),
    ehr: { type: Type.BOOLEAN }, scope: { type: Type.STRING, enum: ["single", "multiple", "none"] },
    conf: { type: Type.NUMBER },
    pid: P("MRN/id"), name: P("full name"), dob: P("DOB YYYY-MM-DD"), age: P("age"), sex: P("sex"),
    encd: P("encounter date"), enct: P("encounter type"),
  },
  required: ["ehr", "scope"],
};
const TERSE_SYS =
  "Extract EHR screenshot data as compact JSON with short keys: sys(system name), spec(specialty), scr(active screen), ehr(bool is-EHR), scope(single|multiple|none), conf(0-1 single-patient confidence), pid(MRN), name(full name), dob(YYYY-MM-DD), age, sex, encd(encounter date), enct(encounter type). Only visible facts; null if absent. Terse values, no prose, no extra keys, no boxes.";

// think: undefined = model default thinking; 0 = thinking disabled (thinkingBudget 0).
const VARIANTS = [
  { label: "lean/full", schema: LEAN_SCHEMA, sys: LEAN_SYS, maxDim: 0, terse: false, think: undefined },
  { label: "lean/1024", schema: LEAN_SCHEMA, sys: LEAN_SYS, maxDim: 1024, terse: false, think: undefined },
  { label: "lean/768", schema: LEAN_SCHEMA, sys: LEAN_SYS, maxDim: 768, terse: false, think: undefined },
  { label: "lean/768 think=0", schema: LEAN_SCHEMA, sys: LEAN_SYS, maxDim: 768, terse: false, think: 0 },
  { label: "terse/768 think=0", schema: TERSE_SCHEMA, sys: TERSE_SYS, maxDim: 768, terse: true, think: 0 },
  { label: "terse/512 think=0", schema: TERSE_SCHEMA, sys: TERSE_SYS, maxDim: 512, terse: true, think: 0 },
];

// fields we compare against baseline
const FIELDS = ["systemName", "activeFunction", "patientId", "fullName", "dateOfBirth", "sex", "patientScope"];

// Baseline is the full v2 shape (systemMetadata.* nesting, fields are {value,box}).
function standardizeBaseline(out: any) {
  const sm = out.systemMetadata ?? {}, p = out.patient ?? {};
  return {
    systemName: fval(sm.systemName), activeFunction: fval(sm.activeFunction), patientScope: sm.patientScope,
    patientId: fval(p.patientId), fullName: fval(p.fullName), dateOfBirth: fval(p.dateOfBirth), sex: fval(p.sex),
  };
}
// Variant outputs: lean = flat top-level + nested patient; terse = short keys.
function standardize(out: any, terse: boolean) {
  if (!terse) return {
    systemName: out.systemName, activeFunction: out.activeFunction, patientScope: out.patientScope,
    patientId: out.patient?.patientId, fullName: out.patient?.fullName,
    dateOfBirth: out.patient?.dateOfBirth, sex: out.patient?.sex,
  };
  return {
    systemName: out.sys, activeFunction: out.scr, patientId: out.pid, fullName: out.name,
    dateOfBirth: out.dob, sex: out.sex, patientScope: out.scope,
  };
}

async function resize(src: string, maxDim: number, outPath: string): Promise<string> {
  if (!maxDim) return src;
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", src, "-vf", `scale='min(${maxDim},iw)':-2`, outPath],
    { stdout: "ignore", stderr: "ignore" },
  );
  await proc.exited;
  return outPath;
}

function loadBaselines() {
  const dir = join(DATA_DIR, "abstractions");
  const out: any[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ndjson"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        const sm = r.output?.systemMetadata ?? {};
        if (sm.patientScope === "single" && fval(r.output?.patient?.patientId)) out.push(r);
      } catch {}
    }
  }
  return out;
}

async function main() {
  const N = Number(Bun.argv.find((a) => /^\d+$/.test(a))) || 12;
  const onlyIdx = Bun.argv.indexOf("--only");
  const ONLY = onlyIdx >= 0 ? Bun.argv[onlyIdx + 1] : null;
  const RUN = ONLY ? VARIANTS.filter((v) => v.label === ONLY) : VARIANTS;
  const outDir = join(DATA_DIR, "experiments", "prompt-opt");
  mkdirSync(outDir, { recursive: true });
  const tmpDir = join(DATA_DIR, "..", "tmp", "prompt-exp");
  mkdirSync(tmpDir, { recursive: true });

  // pick N high-confidence single-patient images across distinct vendors
  const cands = loadBaselines().sort(
    (a, b) => (b.output.systemMetadata.singlePatientConfidence ?? 0) - (a.output.systemMetadata.singlePatientConfidence ?? 0),
  );
  const seen = new Set<string>(); const picked: any[] = [];
  for (const r of cands) {
    const slug = r.file.split("/")[2];
    if (seen.has(slug)) continue;
    seen.add(slug); picked.push(r);
    if (picked.length >= N) break;
  }

  console.log(`Testing ${picked.length} images × ${RUN.length} variants = ${picked.length * RUN.length} Gemini calls\n`);

  const perVariant: Record<string, { inTok: number; outTok: number; thinkTok: number; n: number; matches: number; fieldHits: Record<string, number> }> = {};
  const baselineAgg = { inTok: 0, outTok: 0, n: 0 };
  for (const v of RUN) perVariant[v.label] = { inTok: 0, outTok: 0, thinkTok: 0, n: 0, matches: 0, fieldHits: Object.fromEntries(FIELDS.map((f) => [f, 0])) };

  const rows: any[] = [];
  let call = 0;
  for (const r of picked) {
    const src = join(DATA_DIR, "..", r.file);
    const base = standardizeBaseline(r.output);
    baselineAgg.inTok += r.usage.inputTokens; baselineAgg.outTok += r.usage.outputTokens; baselineAgg.n++;

    for (const v of RUN) {
      const imgPath = await resize(src, v.maxDim, join(tmpDir, `${v.maxDim || "full"}-${call}.png`));
      const b64 = readFileSync(imgPath).toString("base64");
      let usage: any = {}, parsed: any = {};
      try {
        const config: any = { systemInstruction: v.sys, responseMimeType: "application/json", responseSchema: v.schema };
        if (v.think !== undefined) config.thinkingConfig = { thinkingBudget: v.think };
        const resp = await ai.models.generateContent({
          model: MODEL,
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: b64 } }, { text: "Extract per instructions." }] }],
          config,
        });
        usage = resp.usageMetadata ?? {};
        parsed = JSON.parse((resp.text ?? "{}").replace(/^```json\s*|\s*```$/g, ""));
      } catch (e) { console.error(`  ${v.label} #${call}: ${(e as Error).message}`); }
      call++;

      const got = standardize(parsed, v.terse);
      let hits = 0;
      for (const f of FIELDS) {
        const match = norm((got as any)[f]) === norm((base as any)[f]);
        if (match) { hits++; perVariant[v.label].fieldHits[f]++; }
      }
      const think = usage.thoughtsTokenCount ?? 0;
      const pv = perVariant[v.label];
      pv.inTok += usage.promptTokenCount ?? 0; pv.outTok += usage.candidatesTokenCount ?? 0; pv.thinkTok += think; pv.n++;
      pv.matches += hits;
      const diffs = {};
      for (const f of FIELDS) diffs[f] = { base: base[f] ?? null, got: got[f] ?? null, ok: norm(got[f]) === norm(base[f]) };
      rows.push({ file: r.file, variant: v.label, inTok: usage.promptTokenCount, outTok: usage.candidatesTokenCount, thinkTok: think, fieldHits: hits, diffs });
    }
    process.stdout.write(`. (${call} calls)\n`);
  }

  // summarize
  const cost = (i: number, o: number) => (i / 1e6) * RATE_IN + (o / 1e6) * RATE_OUT;
  const baseCostPer = cost(baselineAgg.inTok / baselineAgg.n, baselineAgg.outTok / baselineAgg.n);
  const summary = {
    images: picked.length,
    baseline_full_v2: {
      avgInTok: Math.round(baselineAgg.inTok / baselineAgg.n),
      avgOutTok: Math.round(baselineAgg.outTok / baselineAgg.n),
      costPerImage: round4(baseCostPer),
    },
    variants: RUN.map((v) => {
      const pv = perVariant[v.label];
      const outBillable = (pv.outTok + pv.thinkTok) / pv.n; // thinking tokens bill as output
      const cpi = cost(pv.inTok / pv.n, outBillable);
      return {
        variant: v.label,
        avgInTok: Math.round(pv.inTok / pv.n),
        avgOutTok: Math.round(pv.outTok / pv.n),
        avgThinkTok: Math.round(pv.thinkTok / pv.n),
        avgBillableOutTok: Math.round(outBillable),
        costPerImage: round4(cpi),
        savingsVsBaseline: `${Math.round((1 - cpi / baseCostPer) * 100)}%`,
        fieldAgreementVsBaseline: `${Math.round((100 * pv.matches) / (pv.n * FIELDS.length))}%`,
        perField: Object.fromEntries(FIELDS.map((f) => [f, `${Math.round((100 * pv.fieldHits[f]) / pv.n)}%`])),
      };
    }),
  };
  writeFileSync(join(outDir, ONLY ? "results-verify.json" : "results.json"), JSON.stringify({ summary, rows }, null, 2));
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
}
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
main().catch((e) => { console.error("✗", e.message); process.exit(1); });
