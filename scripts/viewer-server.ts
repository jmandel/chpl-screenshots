/**
 * Viewer server for EHR-screenshot abstractions.
 * - GET /              -> serves the HTML app
 * - GET /api/records   -> parsed records from data/abstractions.ndjson (with stable `index`)
 * - GET /img?file=...  -> serves image bytes from data/screenshots/ (path-traversal safe)
 * - static assets       -> served from public/
 */

import { resolve, relative, isAbsolute, extname, join } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const PUBLIC_DIR = join(PROJECT_ROOT, "public");
const NDJSON_PATH = join(PROJECT_ROOT, "data", "abstractions.ndjson");
const SCREENSHOTS_DIR = join(PROJECT_ROOT, "data", "screenshots");
const PORT = Number(process.env.PORT) || 5599;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** slug -> CHPL seed (vendor / product(s) / website), loaded from the worklist. */
async function loadSeeds(): Promise<Record<string, any>> {
  try {
    const wl = await Bun.file(join(PROJECT_ROOT, "data", "vendor-worklist.json")).json();
    const map: Record<string, any> = {};
    for (const v of wl.vendors ?? []) {
      map[v.slug] = {
        vendor: v.vendor,
        products: v.topProducts ?? [],
        website: v.website ?? null,
        listingCount: v.listingCount,
      };
    }
    return map;
  } catch {
    return {};
  }
}

/** Derive the vendor slug from a record's file path (data/screenshots/<slug>/...). */
function slugFromFile(file: string): string {
  const m = /screenshots\/([^/]+)\//.exec(file || "");
  return m ? m[1] : "";
}

/** Coverage report: vendors/products tried vs found, screenshots-per-product histogram, etc. */
async function buildReport() {
  const records = await readRecords();

  // worklist total + per-attempt
  let totalVendors = 0, attempted = 0, chplListings = 0;
  try {
    const wl = await Bun.file(join(PROJECT_ROOT, "data", "vendor-worklist.json")).json();
    totalVendors = (wl.vendors ?? []).length;
    chplListings = (wl.vendors ?? []).reduce((s: number, v: any) => s + (v.listingCount ?? 0), 0);
  } catch {}
  const attemptDir = join(PROJECT_ROOT, "data", "attempts");
  const attemptedSlugs = new Set<string>();
  try {
    for await (const f of new Bun.Glob("*.json").scan({ cwd: attemptDir })) {
      attemptedSlugs.add(f.replace(/\.json$/, ""));
    }
  } catch {}
  attempted = attemptedSlugs.size;

  // Per-vendor funnel flags + per-screenshot signals
  const foundBySlug = new Map<string, number>();
  const detectedProducts = new Set<string>();
  const vendorEhr = new Set<string>();         // ≥1 screenshot that is an EHR screen
  const vendorSingle = new Set<string>();      // ≥1 single-patient EHR screen
  const vendorHiConf = new Set<string>();      // ≥1 single-patient screen at conf ≥ 0.8
  const confBins = Array.from({ length: 10 }, () => 0); // [0,.1)…[.9,1]
  let confSum = 0, confN = 0;
  const fval = (x: any) => (x && typeof x === "object" && "value" in x ? x.value : x);
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

  // FUNNEL: how many vendors pass each stage
  const funnel = [
    { stage: "Tried", vendors: attempted },
    { stage: "Any screenshot", vendors: foundBySlug.size },
    { stage: "≥1 EHR screen", vendors: vendorEhr.size },
    { stage: "≥1 single-patient", vendors: vendorSingle.size },
    { stage: "single-patient ≥0.8 conf", vendors: vendorHiConf.size },
  ];

  // CONFIDENCE histogram across all screenshots (singlePatientConfidence)
  const confHistogram = confBins.map((count, i) => ({
    bin: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
    count,
  }));

  const totalCostUSD = records.reduce((s, r) => s + (r.price?.totalUSD ?? 0), 0);
  const inTok = records.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0);
  const outTok = records.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0);

  // cost-per-screenshot distribution (bins of 0.2¢ = $0.002)
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
      inputTokens: inTok, outputTokens: outTok,
    },
    avgSinglePatientConfidence: confN ? Math.round((confSum / confN) * 100) / 100 : null,
    funnel,
    confHistogram,
    costHistogram,
  };
}

async function readRecords(): Promise<any[]> {
  // Read the merged file plus any per-EHR shards in data/abstractions/ (written
  // live by concurrent abstraction runs), so the viewer updates as work lands.
  const sources: string[] = [NDJSON_PATH];
  try {
    const shardDir = join(PROJECT_ROOT, "data", "abstractions");
    for await (const rel of new Bun.Glob("*.ndjson").scan({ cwd: shardDir })) {
      sources.push(join(shardDir, rel));
    }
  } catch {
    // no shard dir yet
  }

  const seeds = await loadSeeds();
  const out: any[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const src of sources) {
    let text: string;
    try { text = await Bun.file(src).text(); } catch { continue; }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        if (rec.file && seen.has(rec.file)) continue; // de-dup across sources
        if (rec.file) seen.add(rec.file);
        rec.index = index++;
        rec.slug = slugFromFile(rec.file);            // CHPL vendor slug
        rec.seed = seeds[rec.slug] ?? null;           // cross-correlated CHPL seed
        out.push(rec);
      } catch {
        // skip malformed / partially-written lines gracefully
      }
    }
  }
  return out;
}

/** Resolve a requested file path safely under SCREENSHOTS_DIR. Returns null if rejected. */
function safeImagePath(fileParam: string): string | null {
  if (!fileParam) return null;
  // The record `file` is relative to project root (e.g. data/screenshots/...).
  // Accept either that form or a path relative to data/screenshots.
  let candidate: string;
  if (isAbsolute(fileParam)) {
    candidate = resolve(fileParam);
  } else if (fileParam.startsWith("data/")) {
    candidate = resolve(PROJECT_ROOT, fileParam);
  } else {
    candidate = resolve(SCREENSHOTS_DIR, fileParam);
  }
  const rel = relative(SCREENSHOTS_DIR, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null; // traversal / outside
  return candidate;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/" || pathname === "/index.html") {
      const f = Bun.file(join(PUBLIC_DIR, "index.html"));
      return new Response(f, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (pathname === "/api/records") {
      const records = await readRecords();
      return Response.json(records, { headers: { "cache-control": "no-store" } });
    }

    if (pathname === "/api/report") {
      return Response.json(await buildReport(), { headers: { "cache-control": "no-store" } });
    }

    if (pathname === "/img") {
      const fileParam = url.searchParams.get("file") ?? "";
      const path = safeImagePath(fileParam);
      if (!path) return new Response("Forbidden", { status: 403 });
      const f = Bun.file(path);
      if (!(await f.exists())) return new Response("Not found", { status: 404 });
      return new Response(f, { headers: { "content-type": contentTypeFor(path) } });
    }

    // Static assets from public/
    const assetPath = resolve(PUBLIC_DIR, "." + pathname);
    const rel = relative(PUBLIC_DIR, assetPath);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      const f = Bun.file(assetPath);
      if (await f.exists()) {
        return new Response(f, { headers: { "content-type": contentTypeFor(assetPath), "cache-control": "no-store" } });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Viewer running at http://localhost:${server.port}`);
