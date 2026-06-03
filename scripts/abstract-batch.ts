/**
 * Batch-run the EHR screenshot abstraction over N screenshots, accumulating one
 * record per screenshot into an append-only NDJSON file we can keep growing.
 *
 * Each NDJSON line: { ts, file, model, imageSize, usage{in,out,total},
 *                     price{...}|null, output<the abstraction JSON> }
 *
 * Already-processed files (by path, present in the NDJSON) are skipped unless
 * --force, so re-running just tops up with new screenshots.
 *
 * Usage:
 *   bun run scripts/abstract-batch.ts                 # 10 screenshots from data/screenshots
 *   bun run scripts/abstract-batch.ts --n 25
 *   bun run scripts/abstract-batch.ts a.png b.png     # explicit files
 *   bun run scripts/abstract-batch.ts --force         # re-process even if already recorded
 *
 * Pricing: set GEMINI_PRICE_IN / GEMINI_PRICE_OUT (USD per 1M tokens) to attach
 * cost; otherwise price is null ("unknown").
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { DATA_DIR } from "./chpl.ts";
import { abstractScreenshot } from "./abstract-screenshot.ts";

const NDJSON = join(DATA_DIR, "abstractions.ndjson");

// Known per-1M-token rates (USD) by model. Override at runtime with
// GEMINI_PRICE_IN / GEMINI_PRICE_OUT.
// gemini-3.5-flash: $1.50 / $9.00 standard (cached input $0.15). Source:
//   https://ai.google.dev/gemini-api/docs/pricing (May 2026 launch pricing).
const PRICING: Record<string, { input: number; output: number }> = {
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
};

function rates(model: string): { input: number; output: number } | null {
  const envIn = Number(process.env.GEMINI_PRICE_IN);
  const envOut = Number(process.env.GEMINI_PRICE_OUT);
  if (envIn > 0 && envOut > 0) return { input: envIn, output: envOut };
  return PRICING[model] ?? null;
}

function priceFor(model: string, inTok: number, outTok: number) {
  const r = rates(model);
  if (!r) return null;
  const inputUSD = (inTok / 1e6) * r.input;
  const outputUSD = (outTok / 1e6) * r.output;
  return {
    inputUSD: round6(inputUSD),
    outputUSD: round6(outputUSD),
    totalUSD: round6(inputUSD + outputUSD),
    ratesPer1M: r,
  };
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Count boxes anywhere in the v2 output (every {value,box} field + additionalFields). */
function countBoxes(node: any): number {
  if (Array.isArray(node)) return node.reduce((n, v) => n + countBoxes(v), 0);
  if (!node || typeof node !== "object") return 0;
  let n = node.box && typeof node.box.xmin === "number" ? 1 : 0;
  for (const k of Object.keys(node)) if (k !== "box" && k !== "boxPx") n += countBoxes(node[k]);
  return n;
}

function parseArgs(argv: string[]) {
  let n = 10;
  let force = false;
  let out = NDJSON;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--n") n = Number(argv[++i]);
    else if (a === "--force" || a === "-f") force = true;
    else if (a === "--out") out = argv[++i];
    else files.push(a);
  }
  return { n, force, files, out };
}

/** Round-robin across vendor dirs for a diverse default selection. */
async function defaultScreenshots(limit: number): Promise<string[]> {
  const glob = new Bun.Glob("screenshots/*/*.{png,jpg,jpeg,webp}");
  const byDir = new Map<string, string[]>();
  for await (const rel of glob.scan({ cwd: DATA_DIR })) {
    const abs = join(DATA_DIR, rel);
    const dir = rel.split("/").slice(0, 2).join("/");
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(abs);
  }
  for (const arr of byDir.values()) arr.sort();
  const queues = [...byDir.values()];
  const picked: string[] = [];
  let i = 0;
  while (picked.length < limit && queues.some((q) => q.length)) {
    const q = queues[i % queues.length];
    if (q.length) picked.push(q.shift()!);
    i++;
  }
  return picked;
}

function alreadyDone(path: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).file); } catch {}
  }
  return done;
}

async function main() {
  const { n, force, files, out } = parseArgs(Bun.argv.slice(2));
  const targets = files.length ? files : await defaultScreenshots(n);
  const done = force ? new Set<string>() : alreadyDone(out);
  mkdirSync(dirname(out), { recursive: true });

  console.log(`Processing up to ${targets.length} screenshot(s) → ${relative(process.cwd(), out)}\n`);

  let processed = 0, skipped = 0;
  let totIn = 0, totOut = 0;
  for (const file of targets) {
    const rel = relative(process.cwd(), file);
    if (done.has(rel)) { console.log(`· skip (already done) ${rel}`); skipped++; continue; }

    try {
      const res = await abstractScreenshot(file);
      const price = priceFor(res.model, res.usage.inputTokens, res.usage.outputTokens);
      const record = {
        ts: new Date().toISOString(),
        file: rel,
        model: res.model,
        imageSize: res.imageSize,
        usage: res.usage,
        price,
        output: res.data,
      };
      appendFileSync(out, JSON.stringify(record) + "\n");
      totIn += res.usage.inputTokens;
      totOut += res.usage.outputTokens;
      processed++;
      const fv = (f: any) => (f && typeof f === "object" ? f.value : f) ?? "—";
      const pat = fv(res.data?.patient?.fullName);
      const fn = fv(res.data?.systemMetadata?.activeFunction);
      const boxes = countBoxes(res.data);
      console.log(
        `✓ ${rel}\n    tokens in/out: ${res.usage.inputTokens}/${res.usage.outputTokens}` +
          `${price ? `  $${price.totalUSD}` : "  (price: unknown)"}` +
          `  | patient: ${pat}  func: ${fn}  boxes: ${boxes}`,
      );
    } catch (err) {
      console.error(`✗ ${rel}: ${(err as Error).message}`);
    }
  }

  console.log(
    `\nDone. processed=${processed} skipped=${skipped}  tokens in/out=${totIn}/${totOut}` +
      `${rates("any") || process.env.GEMINI_PRICE_IN ? "" : "  (set GEMINI_PRICE_IN/OUT for cost)"}`,
  );
}

main().catch((err) => {
  console.error("✗", err.message);
  process.exit(1);
});
