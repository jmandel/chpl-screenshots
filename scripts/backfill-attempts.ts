/**
 * Backfill the data/attempts/ ledger for EHRs that were processed before agents
 * started writing their own attempt markers (e.g. the first tranche).
 *
 * Marks the FIRST N vendors in worklist order as attempted, deriving `found`
 * from whether a shard exists (and its line count). Idempotent.
 *
 * Usage: bun run scripts/backfill-attempts.ts [N=150]
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./chpl.ts";

const N = Number(Bun.argv[2]) || 150;
const ATTEMPTS = join(DATA_DIR, "attempts");
mkdirSync(ATTEMPTS, { recursive: true });

const wl = JSON.parse(readFileSync(join(DATA_DIR, "vendor-worklist.json"), "utf8"));
const vendors = (wl.vendors ?? []).slice(0, N);

let marked = 0, hits = 0;
for (const v of vendors) {
  const shard = join(DATA_DIR, "abstractions", `${v.slug}.ndjson`);
  const shotDir = join(DATA_DIR, "screenshots", v.slug);
  let found = 0;
  if (existsSync(shard)) {
    found = readFileSync(shard, "utf8").split("\n").filter((l) => l.trim()).length;
  }
  if (found === 0 && existsSync(shotDir)) {
    // dir exists but shard not yet written: count keeper PNGs
    found = [...new Bun.Glob("*.{png,jpg,jpeg,webp}").scanSync({ cwd: shotDir })].length;
  }
  if (found > 0) hits++;
  writeFileSync(
    join(ATTEMPTS, `${v.slug}.json`),
    JSON.stringify({ slug: v.slug, found, backfilled: true }),
  );
  marked++;
}

console.log(`✓ Backfilled ${marked} attempt markers (first ${N} worklist slugs); ${hits} had screenshots.`);
