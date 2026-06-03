/**
 * Pure data layer shared by the static builder (and usable by the dev server):
 * read the abstraction shards (joined to the CHPL seed) and compute the coverage
 * report. No server, no side effects — safe to import.
 */
import { join } from "node:path";
import { DATA_DIR } from "./chpl.ts";

const PROJECT_ROOT = join(DATA_DIR, "..");
const NDJSON_PATH = join(DATA_DIR, "abstractions.ndjson");

export async function loadSeeds(): Promise<Record<string, any>> {
  try {
    const wl = await Bun.file(join(DATA_DIR, "vendor-worklist.json")).json();
    const map: Record<string, any> = {};
    for (const v of wl.vendors ?? []) {
      map[v.slug] = { vendor: v.vendor, products: v.topProducts ?? [], website: v.website ?? null, listingCount: v.listingCount };
    }
    return map;
  } catch { return {}; }
}

export function slugFromFile(file: string): string {
  const m = /screenshots\/([^/]+)\//.exec(file || "");
  return m ? m[1] : "";
}

export async function readRecords(): Promise<any[]> {
  const sources: string[] = [NDJSON_PATH];
  try {
    const shardDir = join(DATA_DIR, "abstractions");
    for await (const rel of new Bun.Glob("*.ndjson").scan({ cwd: shardDir })) sources.push(join(shardDir, rel));
  } catch {}
  const seeds = await loadSeeds();
  const out: any[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const src of sources) {
    let text: string;
    try { text = await Bun.file(src).text(); } catch { continue; }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec.file && seen.has(rec.file)) continue;
        if (rec.file) seen.add(rec.file);
        rec.index = index++;
        rec.slug = slugFromFile(rec.file);
        rec.seed = seeds[rec.slug] ?? null;
        out.push(rec);
      } catch {}
    }
  }
  return out;
}

const fval = (x: any) => (x && typeof x === "object" && "value" in x ? x.value : x);

export function patientName(o: any): any {
  const p = o.patient || {};
  return fval(p.fullName) ?? (p.name && p.name.fullName) ?? null;
}

// Same filter semantics as the web app (public/app.js recMatches) — keep in sync.
const _incl = (h: any, n: any) => String(h == null ? "" : h).toLowerCase().includes(String(n).toLowerCase());
const _getPath = (obj: any, path: string) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
export function recMatches(r: any, f: any): boolean {
  if (!f) return true;
  const o = r.output || {}, sm = o.systemMetadata || {}, conf = sm.singlePatientConfidence;
  if (f.confMin != null && !(typeof conf === "number" && conf >= f.confMin)) return false;
  if (f.confMax != null && !(typeof conf === "number" && conf < f.confMax)) return false;
  if (f.isEhrScreen != null && sm.isEhrScreen !== f.isEhrScreen) return false;
  if (f.patientScope && sm.patientScope !== f.patientScope) return false;
  if (f.systemName && !_incl(fval(sm.systemName), f.systemName)) return false;
  if (f.patientName && !_incl(patientName(o), f.patientName)) return false;
  if (f.vendor && !_incl(r.seed?.vendor || r.slug, f.vendor)) return false;
  const cost = r.price?.totalUSD;
  if (f.costMin != null && !(cost >= f.costMin)) return false;
  if (f.costMax != null && !(cost < f.costMax)) return false;
  if (f.field) {
    const v = fval(_getPath(o, f.field));
    if (f.present === true && (v == null || v === "")) return false;
    if (f.present === false && !(v == null || v === "")) return false;
    if (f.contains != null && !_incl(v, f.contains)) return false;
    if (f.equals != null && String(v == null ? "" : v).toLowerCase() !== String(f.equals).toLowerCase()) return false;
  }
  return true;
}

/** Single-patient-confidence score for ranking a vendor's shots (single-patient first, then confidence). */
export function shotScore(r: any): number {
  const sm = r.output?.systemMetadata ?? {};
  const single = sm.isEhrScreen === true && sm.patientScope === "single" ? 1 : 0;
  return single * 1000 + (typeof sm.singlePatientConfidence === "number" ? sm.singlePatientConfidence : 0);
}

export async function buildReport(records?: any[]) {
  records = records ?? (await readRecords());
  let totalVendors = 0, chplListings = 0;
  try {
    const wl = await Bun.file(join(DATA_DIR, "vendor-worklist.json")).json();
    totalVendors = (wl.vendors ?? []).length;
    chplListings = (wl.vendors ?? []).reduce((s: number, v: any) => s + (v.listingCount ?? 0), 0);
  } catch {}
  const attemptedSlugs = new Set<string>();
  try {
    for await (const f of new Bun.Glob("*.json").scan({ cwd: join(DATA_DIR, "attempts") }))
      attemptedSlugs.add(f.replace(/\.json$/, ""));
  } catch {}
  const attempted = attemptedSlugs.size;

  const foundBySlug = new Map<string, number>();
  const detectedProducts = new Set<string>();
  const vendorEhr = new Set<string>(), vendorSingle = new Set<string>(), vendorHiConf = new Set<string>();
  const confBins = Array.from({ length: 10 }, () => 0);
  let confSum = 0, confN = 0;
  for (const r of records) {
    foundBySlug.set(r.slug, (foundBySlug.get(r.slug) ?? 0) + 1);
    const sm = r.output?.systemMetadata ?? {};
    const name = fval(sm.systemName);
    if (name) detectedProducts.add(String(name).trim().toLowerCase());
    if (sm.isEhrScreen === true) vendorEhr.add(r.slug);
    const single = sm.isEhrScreen === true && sm.patientScope === "single";
    if (single) vendorSingle.add(r.slug);
    const c = sm.singlePatientConfidence;
    if (typeof c === "number") {
      confSum += c; confN++;
      confBins[Math.min(9, Math.max(0, Math.floor(c * 10)))]++;
      if (single && c >= 0.8) vendorHiConf.add(r.slug);
    }
  }

  const funnel = [
    { stage: "Tried", vendors: attempted },
    { stage: "Any screenshot", vendors: foundBySlug.size },
    { stage: "≥1 EHR screen", vendors: vendorEhr.size },
    { stage: "≥1 single-patient", vendors: vendorSingle.size },
    { stage: "single-patient ≥0.8 conf", vendors: vendorHiConf.size },
  ];
  const confHistogram = confBins.map((count, i) => ({ bin: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`, count }));

  const totalCostUSD = records.reduce((s, r) => s + (r.price?.totalUSD ?? 0), 0);
  const costs = records.map((r) => r.price?.totalUSD ?? 0).sort((a, b) => a - b);
  const avgCost = costs.length ? totalCostUSD / costs.length : 0;
  const medianCost = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
  const cw = 0.002, nb = 12;
  const costHistogram = Array.from({ length: nb + 1 }, (_, i) => ({
    label: i < nb ? `${(i * cw * 100).toFixed(1)}¢` : `${(nb * cw * 100).toFixed(1)}¢+`,
    count: costs.filter((c) => (i < nb ? c >= i * cw && c < (i + 1) * cw : c >= nb * cw)).length,
  }));

  return {
    vendors: { total: totalVendors, attempted, withScreenshots: foundBySlug.size, none: attempted - foundBySlug.size },
    products: { chplActiveListings: chplListings, detectedOnScreen: detectedProducts.size },
    screenshots: { total: records.length },
    cost: {
      totalUSD: Math.round(totalCostUSD * 1000) / 1000,
      avgPerScreenshot: Math.round(avgCost * 1e5) / 1e5,
      medianPerScreenshot: Math.round(medianCost * 1e5) / 1e5,
      inputTokens: records.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0),
      outputTokens: records.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0),
    },
    avgSinglePatientConfidence: confN ? Math.round((confSum / confN) * 100) / 100 : null,
    funnel, confHistogram, costHistogram,
  };
}
