/**
 * Re-abstract any v1 shards to the v2 schema (inline {value, box} fields).
 *
 * A shard is v1 if its first record's output has an `annotations` array or a
 * string `patient.patientId` (v2 wraps every field as an object). For each v1
 * shard, delete it and re-run the v2 abstraction over that slug's screenshots.
 *
 * Usage:
 *   bun run scripts/reabstract-v1.ts            # list v1 shards (dry run)
 *   bun run scripts/reabstract-v1.ts --apply    # re-abstract them
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./chpl.ts";
import { abstractScreenshot } from "./abstract-screenshot.ts";
import { appendFileSync } from "node:fs";

const SHARD_DIR = join(DATA_DIR, "abstractions");
const SHOTS = join(DATA_DIR, "screenshots");

function isV1(shardPath: string): boolean {
  const first = readFileSync(shardPath, "utf8").split("\n").find((l) => l.trim());
  if (!first) return false;
  try {
    const o = JSON.parse(first).output || {};
    if (Array.isArray(o.annotations)) return true;             // v1 had annotations[]
    if (typeof o?.patient?.patientId === "string") return true; // v1 fields were bare strings
    return false;
  } catch { return false; }
}

async function main() {
  const apply = Bun.argv.includes("--apply");
  const shards = readdirSync(SHARD_DIR).filter((f) => f.endsWith(".ndjson"));
  const v1 = shards.filter((f) => isV1(join(SHARD_DIR, f)));

  console.log(`${shards.length} shards, ${v1.length} are v1${apply ? "" : " (dry run — pass --apply)"}`);
  for (const f of v1) console.log("  v1:", f);
  if (!apply || !v1.length) return;

  for (const f of v1) {
    const slug = f.replace(/\.ndjson$/, "");
    const dir = join(SHOTS, slug);
    let imgs: string[] = [];
    try { imgs = [...new Bun.Glob("*.{png,jpg,jpeg,webp}").scanSync({ cwd: dir })].map((n) => join(dir, n)); } catch {}
    if (!imgs.length) { console.log(`· ${slug}: no screenshots, skipping`); continue; }
    rmSync(join(SHARD_DIR, f));
    for (const img of imgs.sort()) {
      try {
        const res = await abstractScreenshot(img);
        const u = res.usage;
        const price = { inputUSD: (u.inputTokens / 1e6) * 1.5, outputUSD: (u.outputTokens / 1e6) * 9.0 };
        appendFileSync(join(SHARD_DIR, f), JSON.stringify({
          ts: new Date().toISOString(), file: img.replace(DATA_DIR + "/", "data/"),
          model: res.model, imageSize: res.imageSize, usage: u,
          price: { ...price, totalUSD: Math.round((price.inputUSD + price.outputUSD) * 1e6) / 1e6, ratesPer1M: { input: 1.5, output: 9 } },
          output: res.data,
        }) + "\n");
      } catch (e) { console.error(`  ✗ ${img}: ${(e as Error).message}`); }
    }
    console.log(`✓ re-abstracted ${slug} (${imgs.length} images)`);
  }
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
