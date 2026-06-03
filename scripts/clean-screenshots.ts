/**
 * Sweep data/screenshots/ so it contains ONLY verified keepers.
 *
 * A keeper is a top-level image named like "01-something.png" (NN-desc.<ext>).
 * Everything else is scratch and gets removed: subdirs (frames/, etc.), videos,
 * yt-dlp .part/.ytdl files, montages, oddly-named candidates. A vendor dir with
 * no keepers left is a "miss" and is deleted entirely (we don't keep empty dirs
 * or lone manifests for misses).
 *
 * Usage:
 *   bun run clean            # show what would be removed (dry run)
 *   bun run clean -- --apply # actually delete
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "./chpl.ts";

const KEEPER = /^\d{1,2}-.+\.(png|jpe?g|webp)$/i;
const KEEP_ALSO = new Set(["manifest.json"]);

async function main() {
  const apply = Bun.argv.slice(2).includes("--apply");
  const root = join(DATA_DIR, "screenshots");

  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    console.log("(no data/screenshots dir — nothing to clean)");
    return;
  }

  const toRemove: string[] = [];
  const dirsToDrop: string[] = [];

  for (const slug of dirs) {
    const dir = join(root, slug);
    if (!(await stat(dir)).isDirectory()) continue;

    const entries = await readdir(dir);
    let keepers = 0;
    for (const name of entries) {
      const full = join(dir, name);
      const isDir = (await stat(full)).isDirectory();
      if (!isDir && KEEPER.test(name)) {
        keepers++;
      } else if (!isDir && KEEP_ALSO.has(name)) {
        // keep manifest for now; decided per-dir below
      } else {
        toRemove.push(full + (isDir ? "/" : ""));
      }
    }
    // No verified images => miss => drop the whole dir (incl. any manifest).
    if (keepers === 0) dirsToDrop.push(dir);
  }

  if (!toRemove.length && !dirsToDrop.length) {
    console.log("✓ data/screenshots is already clean.");
    return;
  }

  console.log(`${apply ? "Removing" : "[dry run] would remove"}:`);
  for (const p of toRemove) console.log("  scratch  " + p);
  for (const d of dirsToDrop) console.log("  MISS dir " + d + "/  (no keepers)");

  if (apply) {
    for (const p of toRemove) await rm(p, { recursive: true, force: true });
    for (const d of dirsToDrop) await rm(d, { recursive: true, force: true });
    console.log("\n✓ Done.");
  } else {
    console.log("\nRe-run with --apply to delete.");
  }
}

main().catch((err) => {
  console.error("✗", err.message);
  process.exit(1);
});
