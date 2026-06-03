/**
 * Re-abstract EVERY screenshot to the current (v3) schema, overwriting each
 * per-vendor shard fresh (data/abstractions/<slug>.ndjson). Concurrent.
 *
 * Usage: bun run scripts/reabstract-all.ts [--concurrency N] [--debug]
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { DATA_DIR } from "./chpl.ts";
import { abstractScreenshot } from "./abstract-screenshot.ts";

const ROOT = join(DATA_DIR, "..");
const SHOTS = join(DATA_DIR, "screenshots");
const SHARDS = join(DATA_DIR, "abstractions");
const RATE_IN = 1.5, RATE_OUT = 9.0;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const argN = (f: string, d: number) => { const i = Bun.argv.indexOf(f); return i >= 0 ? Number(Bun.argv[i + 1]) : d; };
const CONC = argN("--concurrency", 10);
const DEBUG = Bun.argv.includes("--debug");

async function main() {
  mkdirSync(SHARDS, { recursive: true });
  const onlyIdx = Bun.argv.indexOf("--slugs");
  const only = onlyIdx >= 0 ? new Set(Bun.argv[onlyIdx + 1].split(",")) : null;
  // group images by slug
  const bySlug = new Map<string, string[]>();
  for await (const rel of new Bun.Glob("*/*.{png,jpg,jpeg,webp}").scan({ cwd: SHOTS })) {
    const slug = rel.split("/")[0];
    if (only && !only.has(slug)) continue;
    (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug)!).push(join(SHOTS, rel));
  }
  const slugs = [...bySlug.keys()].sort();
  const all = [...bySlug.entries()].flatMap(([slug, files]) => files.sort().map((file) => ({ slug, file })));
  const total = all.length;
  console.log(`Re-abstracting ${total} screenshots across ${slugs.length} vendors (v3${DEBUG ? ", debug" : ""}, concurrency ${CONC})`);

  const recordsBySlug = new Map<string, any[]>();
  const remaining = new Map<string, number>();
  for (const [slug, files] of bySlug) { recordsBySlug.set(slug, []); remaining.set(slug, files.length); }

  // remove the optional merged file so it can't shadow stale records
  if (existsSync(join(DATA_DIR, "abstractions.ndjson"))) rmSync(join(DATA_DIR, "abstractions.ndjson"));

  let done = 0, fail = 0, next = 0, totIn = 0, totOut = 0, totCost = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= all.length) return;
      const { slug, file } = all[i];
      try {
        const res = await abstractScreenshot(file, { debug: DEBUG });
        const inputUSD = (res.usage.inputTokens / 1e6) * RATE_IN;
        const outputUSD = (res.usage.outputTokens / 1e6) * RATE_OUT;
        const price = { inputUSD: round6(inputUSD), outputUSD: round6(outputUSD), totalUSD: round6(inputUSD + outputUSD), ratesPer1M: { input: RATE_IN, output: RATE_OUT } };
        recordsBySlug.get(slug)!.push({
          ts: new Date().toISOString(), file: relative(ROOT, file), model: res.model,
          imageSize: res.imageSize, usage: res.usage, price, output: res.data,
        });
        totIn += res.usage.inputTokens; totOut += res.usage.outputTokens; totCost += price.totalUSD;
      } catch (e) {
        fail++;
        console.error(`✗ ${relative(ROOT, file)}: ${(e as Error).message}`);
      }
      // write the shard once all of this slug's images are processed
      if ((remaining.set(slug, remaining.get(slug)! - 1), remaining.get(slug)) === 0) {
        const recs = recordsBySlug.get(slug)!.sort((a, b) => a.file.localeCompare(b.file));
        if (recs.length) writeFileSync(join(SHARDS, `${slug}.ndjson`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
      }
      if (++done % 25 === 0 || done === total) console.log(`  ${done}/${total}  ($${totCost.toFixed(2)} so far)`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  console.log(`\n✓ Done. ${done} processed, ${fail} failed. tokens in/out=${totIn}/${totOut}. cost ~$${totCost.toFixed(2)}`);
}
main().catch((e) => { console.error("✗", e.message); process.exit(1); });
