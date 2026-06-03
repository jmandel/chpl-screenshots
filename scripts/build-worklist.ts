/**
 * Build a randomly-sorted, durable worklist of every certified EHR vendor so we
 * can work down it over time (e.g. hunting screenshots vendor-by-vendor).
 *
 * The randomized order is COMMITTED to data/vendor-worklist.json. Re-running is
 * a no-op unless you pass --force, so per-vendor progress (the `status` field)
 * is never silently lost. The shuffle is seeded and the seed is recorded in the
 * file, so the order is reproducible.
 *
 * Usage:
 *   bun run worklist                 # create data/vendor-worklist.json (once)
 *   bun run worklist -- --seed 99    # different fixed order
 *   bun run worklist -- --type inactive
 *   bun run worklist -- --force      # regenerate (overwrites status!)
 */

import { join } from "node:path";
import { DATA_DIR, loadListings, type ListingType, type Listing } from "./chpl.ts";

interface WorklistEntry {
  order: number;
  status: "pending" | "done" | "empty" | "skip";
  vendor: string;
  developerId: number | null;
  slug: string;
  website: string | null;
  topProducts: string[];
  listingCount: number;
  screenshotsFound: number | null; // filled in as we work the list
}

function parseArgs(argv: string[]) {
  let seed = 42;
  let type: ListingType = "active";
  let force = false;
  let top = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") seed = Number(argv[++i]);
    else if (a === "--type" || a === "-t") type = argv[++i] as ListingType;
    else if (a === "--top") top = Number(argv[++i]);
    else if (a === "--force" || a === "-f") force = true;
  }
  return { seed, type, force, top };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Deterministic PRNG so a given seed always yields the same order. */
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

function buildVendors(listings: Listing[], top: number) {
  const byVendor = new Map<string, Listing[]>();
  for (const l of listings) {
    const key = l.developer.id != null ? `id:${l.developer.id}` : `name:${l.developer.name}`;
    (byVendor.get(key) ?? byVendor.set(key, []).get(key)!).push(l);
  }
  const vendors = [];
  for (const ls of byVendor.values()) {
    const first = ls[0];
    const perProduct = new Map<string, number>();
    for (const l of ls) perProduct.set(l.product.name, (perProduct.get(l.product.name) ?? 0) + 1);
    const topProducts = [...perProduct.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([name]) => name);
    vendors.push({
      vendor: first.developer.name,
      developerId: first.developer.id,
      website: first.developer.website ?? null,
      topProducts,
      listingCount: ls.length,
    });
  }
  // Sort to a stable canonical order BEFORE shuffling so the seed is the only
  // source of randomness (Map iteration order shouldn't leak in).
  vendors.sort((a, b) => a.vendor.localeCompare(b.vendor));
  return vendors;
}

async function main() {
  const { seed, type, force, top } = parseArgs(Bun.argv.slice(2));
  const outFile = join(DATA_DIR, "vendor-worklist.json");

  if (!force && (await Bun.file(outFile).exists())) {
    console.log(
      `✓ ${outFile} already exists — leaving it (and its progress) untouched.\n` +
        `  Use --force to regenerate (this resets all status fields).`,
    );
    return;
  }

  const listings = await loadListings(type);
  const vendors = buildVendors(listings, top);
  const ordered = shuffle(vendors, mulberry32(seed));

  const entries: WorklistEntry[] = ordered.map((v, i) => ({
    order: i + 1,
    status: "pending",
    vendor: v.vendor,
    developerId: v.developerId,
    slug: slugify(v.vendor),
    website: v.website,
    topProducts: v.topProducts,
    listingCount: v.listingCount,
    screenshotsFound: null,
  }));

  await Bun.write(
    outFile,
    JSON.stringify(
      {
        generatedFromType: type,
        seed,
        total: entries.length,
        note: "Randomized worklist. Order is committed; work down it over time. Update each entry's `status` (pending|done|empty|skip) and `screenshotsFound` as you go.",
        vendors: entries,
      },
      null,
      2,
    ),
  );

  console.log(`✓ Wrote ${entries.length} vendors (random order, seed ${seed}) → ${outFile}`);
  console.log(`  First 5 up next:`);
  for (const e of entries.slice(0, 5)) {
    console.log(`   ${e.order}. ${e.vendor}  [${e.topProducts.join(", ")}]`);
  }
}

main().catch((err) => {
  console.error("✗", err.message);
  process.exit(1);
});
