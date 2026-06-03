/**
 * For every current certified EHR vendor (developer), find the name of their
 * top 1-3 products, then take a random sample of vendors.
 *
 * "Top" product = the product with the most certified listings for that vendor
 * (a reasonable proxy for their flagship offering). Ties broken alphabetically.
 *
 * Usage:
 *   bun run sample                       # 50 vendors, top 3 products, seeded
 *   bun run sample -- --n 25 --top 1
 *   bun run sample -- --seed random      # non-reproducible sample
 *   bun run sample -- --type inactive
 *
 * Writes data/vendor-sample.json and prints a table.
 */

import { join } from "node:path";
import { DATA_DIR, loadListings, type ListingType, type Listing } from "./chpl.ts";

interface VendorProducts {
  developerId: number | null;
  developer: string;
  website: string | null;
  productCount: number; // distinct products
  listingCount: number; // total certified listings
  topProducts: { name: string; listings: number }[];
}

function parseArgs(argv: string[]) {
  let n = 50;
  let top = 3;
  let type: ListingType = "active";
  let seed: number | "random" = 1337; // reproducible by default
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--n") n = Number(argv[++i]);
    else if (a === "--top") top = Number(argv[++i]);
    else if (a === "--type" || a === "-t") type = argv[++i] as ListingType;
    else if (a === "--seed") {
      const v = argv[++i];
      seed = v === "random" ? "random" : Number(v);
    }
  }
  return { n, top, type, seed };
}

/** Deterministic PRNG so a given seed always yields the same sample. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildVendors(listings: Listing[], top: number): VendorProducts[] {
  // Group listings by vendor. Prefer developer.id; fall back to name when null.
  const byVendor = new Map<string, Listing[]>();
  for (const l of listings) {
    const key = l.developer.id != null ? `id:${l.developer.id}` : `name:${l.developer.name}`;
    (byVendor.get(key) ?? byVendor.set(key, []).get(key)!).push(l);
  }

  const vendors: VendorProducts[] = [];
  for (const ls of byVendor.values()) {
    const first = ls[0];

    // Count listings per product name for this vendor.
    const perProduct = new Map<string, number>();
    for (const l of ls) {
      perProduct.set(l.product.name, (perProduct.get(l.product.name) ?? 0) + 1);
    }

    const ranked = [...perProduct.entries()]
      .map(([name, listings]) => ({ name, listings }))
      .sort((a, b) => b.listings - a.listings || a.name.localeCompare(b.name));

    vendors.push({
      developerId: first.developer.id,
      developer: first.developer.name,
      website: first.developer.website ?? null,
      productCount: perProduct.size,
      listingCount: ls.length,
      topProducts: ranked.slice(0, top),
    });
  }

  // Stable order before sampling so the seed is the only source of randomness.
  vendors.sort((a, b) => a.developer.localeCompare(b.developer));
  return vendors;
}

async function main() {
  const { n, top, type, seed } = parseArgs(Bun.argv.slice(2));

  const listings = await loadListings(type);
  const vendors = buildVendors(listings, top);

  const rand = seed === "random" ? Math.random : mulberry32(seed);
  const sample = shuffle(vendors, rand).slice(0, Math.min(n, vendors.length));
  // Present the sample alphabetically; the sampling itself was random.
  sample.sort((a, b) => a.developer.localeCompare(b.developer));

  const outFile = join(DATA_DIR, `vendor-sample-${type}.json`);
  await Bun.write(
    outFile,
    JSON.stringify(
      { type, seed, sampleSize: sample.length, totalVendors: vendors.length, vendors: sample },
      null,
      2,
    ),
  );

  console.log(
    `Vendors in ${type} set: ${vendors.length} — random sample of ${sample.length}` +
      (seed === "random" ? " (unseeded)" : ` (seed ${seed})`) +
      `, top ${top} product(s) each:\n`,
  );
  for (const v of sample) {
    const products = v.topProducts
      .map((p) => `${p.name} (${p.listings})`)
      .join(", ");
    console.log(`• ${v.developer}`);
    console.log(`    products: ${products}`);
    if (v.website) console.log(`    website:  ${v.website}`);
  }
  console.log(`\n✓ Wrote ${outFile}`);
}

main().catch((err) => {
  console.error("✗", err.message);
  process.exit(1);
});
