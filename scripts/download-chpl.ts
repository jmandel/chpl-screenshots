/**
 * Download the full CHPL certified-product collection as JSON into ./data.
 *
 * Usage:
 *   bun run download                 # active listings (default), skip if present
 *   bun run download -- --force      # re-download even if the file exists
 *   bun run download -- --type inactive
 *
 * This saves us from rediscovering the (finicky) download endpoint later.
 */

import { mkdir } from "node:fs/promises";
import {
  CHPL_API_KEY,
  DATA_DIR,
  downloadUrl,
  listingFile,
  type ListingType,
} from "./chpl.ts";

function parseArgs(argv: string[]): { type: ListingType; force: boolean } {
  let type: ListingType = "active";
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") force = true;
    else if (a === "--type" || a === "-t") type = argv[++i] as ListingType;
  }
  const allowed: ListingType[] = ["active", "inactive", "2014", "2011"];
  if (!allowed.includes(type)) {
    throw new Error(`--type must be one of: ${allowed.join(", ")}`);
  }
  return { type, force };
}

async function main() {
  const { type, force } = parseArgs(Bun.argv.slice(2));
  const dest = listingFile(type);

  await mkdir(DATA_DIR, { recursive: true });

  if (!force && (await Bun.file(dest).exists())) {
    const bytes = Bun.file(dest).size;
    console.log(`✓ ${dest} already exists (${fmtBytes(bytes)}). Use --force to refresh.`);
    return;
  }

  const url = downloadUrl(type);
  console.log(`Downloading ${type} listings…\n  ${url}`);

  const res = await fetch(url, {
    headers: {
      "api-key": CHPL_API_KEY,
      // Must be */* — application/json triggers a 500 on this endpoint.
      accept: "*/*",
    },
  });
  if (!res.ok) {
    throw new Error(`CHPL responded ${res.status} ${res.statusText}`);
  }

  // The active file is ~150 MB; buffer it, then write to disk.
  const buf = await res.arrayBuffer();
  const bytes = await Bun.write(dest, buf);

  // Sanity check: confirm it parses and count records.
  const records = (await Bun.file(dest).json()) as unknown[];
  console.log(`✓ Saved ${records.length} ${type} listings → ${dest} (${fmtBytes(bytes)})`);
}

function fmtBytes(n: number): string {
  if (n > 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n > 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

main().catch((err) => {
  console.error("✗", err.message);
  process.exit(1);
});
