/**
 * Build the viewer as a static site (no server needed) → ./dist
 *
 *   bun run build                                  # full static site (GH Pages ready)
 *   bun run build -- --single                      # also emit dist/standalone.html (all-in-one)
 *
 * SELECTION FLAGS (compose in this order: filter → per-vendor cap → vendor sample):
 *   --filter '<json>'        Keep only screenshots matching the web app's filter JSON, e.g.
 *                            '{"patientScope":"single","confMin":0.9}' or '{"systemName":"epic"}'
 *                            (same keys the viewer hash accepts: confMin/confMax, isEhrScreen,
 *                             patientScope, systemName, patientName, vendor, costMin/costMax,
 *                             field+present|contains|equals).
 *   --per-vendor <N>         At most N screenshots per EHR vendor, picking the most-confident
 *                            single-patient shots first (then working down).
 *   --sample-vendors <N>     Randomly keep only N vendors (thins the payload across EHRs).
 *   --seed <N>               Seed for --sample-vendors (default 1337; reproducible).
 *
 * Examples:
 *   bun run build -- --single --filter '{"patientScope":"single","confMin":0.9}' --per-vendor 1
 *   bun run build -- --single --sample-vendors 40 --per-vendor 2
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { DATA_DIR } from "./chpl.ts";
import { readRecords, buildReport, recMatches, shotScore } from "./report-data.ts";

const ROOT = join(DATA_DIR, "..");
const PUBLIC = join(ROOT, "public");
const DIST = join(ROOT, "dist");
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const fmt = (n: number) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 10)).toFixed(0)} KB`);

function arg(flag: string): string | null { const i = Bun.argv.indexOf(flag); return i >= 0 ? Bun.argv[i + 1] : null; }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function capPerVendor(recs: any[], n: number): any[] {
  const by = new Map<string, any[]>();
  for (const r of recs) (by.get(r.slug) ?? by.set(r.slug, []).get(r.slug)!).push(r);
  const out: any[] = [];
  for (const arr of by.values()) { arr.sort((x, y) => shotScore(y) - shotScore(x)); out.push(...arr.slice(0, n)); }
  return out;
}

function sampleVendors(recs: any[], n: number, seed: number): any[] {
  const slugs = [...new Set(recs.map((r) => r.slug))];
  const rand = mulberry32(seed);
  for (let i = slugs.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [slugs[i], slugs[j]] = [slugs[j], slugs[i]]; }
  const keep = new Set(slugs.slice(0, n));
  return recs.filter((r) => keep.has(r.slug));
}

async function main() {
  const single = Bun.argv.includes("--single");
  const filter = arg("--filter") ? JSON.parse(arg("--filter")!) : null;
  const perVendor = arg("--per-vendor") ? Number(arg("--per-vendor")) : null;
  const sampleN = arg("--sample-vendors") ? Number(arg("--sample-vendors")) : null;
  const seed = arg("--seed") ? Number(arg("--seed")) : 1337;

  const all = await readRecords();
  let recs = all;
  if (filter) recs = recs.filter((r) => recMatches(r, filter));
  if (perVendor) recs = capPerVendor(recs, perVendor);
  if (sampleN) recs = sampleVendors(recs, sampleN, seed);
  // re-index so the frontend's #/<index> routing is contiguous
  recs.forEach((r, i) => (r.index = i));

  const vendorsKept = new Set(recs.map((r) => r.slug)).size;
  console.log(`Selection: ${all.length} → ${recs.length} screenshots across ${vendorsKept} vendors` +
    `${filter ? `  [filter ${JSON.stringify(filter)}]` : ""}${perVendor ? `  [≤${perVendor}/vendor]` : ""}${sampleN ? `  [${sampleN} random vendors, seed ${seed}]` : ""}`);

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  for (const f of ["index.html", "app.js", "style.css"]) cpSync(join(PUBLIC, f), join(DIST, f));

  // nextgen design doc → served at /nextgen.html and /nextgen/ (directory index)
  cpSync(join(ROOT, "nextgen.html"), join(DIST, "nextgen.html"));
  mkdirSync(join(DIST, "nextgen"), { recursive: true });
  cpSync(join(ROOT, "nextgen.html"), join(DIST, "nextgen", "index.html"));

  const report = await buildReport(recs);
  writeFileSync(join(DIST, "records.json"), JSON.stringify(recs));
  writeFileSync(join(DIST, "report.json"), JSON.stringify(report));

  let copied = 0, imgBytes = 0;
  for (const r of recs) {
    const rel = r.file.replace(/^data\//, "");
    const src = join(ROOT, r.file);
    if (existsSync(src)) { mkdirSync(join(DIST, rel, ".."), { recursive: true }); cpSync(src, join(DIST, rel)); copied++; imgBytes += Bun.file(src).size; }
  }
  console.log(`✓ dist/ built: ${recs.length} records, ${copied} screenshots (~${fmt(imgBytes)}). Deploy ./dist to any static host.`);

  if (single) {
    const css = readFileSync(join(DIST, "style.css"), "utf8");
    const js = readFileSync(join(DIST, "app.js"), "utf8");
    const images: Record<string, string> = {};
    for (const r of recs) {
      const rel = r.file.replace(/^data\//, ""); const src = join(ROOT, r.file);
      if (existsSync(src)) images[rel] = `data:${MIME[extname(src).toLowerCase()] ?? "image/png"};base64,${readFileSync(src).toString("base64")}`;
    }
    const html = readFileSync(join(DIST, "index.html"), "utf8")
      .replace('<link rel="stylesheet" href="/style.css" />', `<style>\n${css}\n</style>`)
      .replace('<script src="/app.js"></script>', `<script>window.__EHR__=${JSON.stringify({ records: recs, report, images })};</script>\n<script>\n${js}\n</script>`);
    writeFileSync(join(DIST, "standalone.html"), html);
    console.log(`✓ standalone.html: ${fmt(Bun.file(join(DIST, "standalone.html")).size)} (one shareable file, ${Object.keys(images).length} images inlined)`);
  }
}
main().catch((e) => { console.error("✗", e.message); process.exit(1); });
