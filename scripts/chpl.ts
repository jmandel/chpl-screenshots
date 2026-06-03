/**
 * Shared CHPL (Certified Health IT Product List) helpers.
 *
 * Reference: https://chpl.healthit.gov/#/resources/api
 * OpenAPI:   https://chpl.healthit.gov/rest/v3/api-docs
 *
 * The bulk "entire collection of certified products" download lives at
 * GET /rest/listings/download. Two non-obvious requirements:
 *   - format=json (the server default is csv)
 *   - Accept must be the wildcard star-slash-star; sending Accept:
 *     application/json makes content negotiation fail with HTTP 500
 *     "No acceptable representation".
 */

import { join } from "node:path";

/** Public CHPL API key. CHPL requires one but does not gate this endpoint. */
export const CHPL_API_KEY =
  process.env.CHPL_API_KEY ?? "12909a978483dfb8ecd0596c98ae9094";

export const DATA_DIR = join(import.meta.dir, "..", "data");

/** Listing collections offered by /rest/listings/download. */
export type ListingType = "active" | "inactive" | "2014" | "2011";

export function listingFile(type: ListingType): string {
  return join(DATA_DIR, `chpl-${type}-listings.json`);
}

export function downloadUrl(type: ListingType): string {
  const u = new URL("https://chpl.healthit.gov/rest/listings/download");
  u.searchParams.set("listingType", type);
  u.searchParams.set("format", "json");
  return u.toString();
}

/** Minimal shape of a CHPL listing record (only the fields we use). */
export interface Listing {
  id: number;
  chplProductNumber: string;
  certificationDate: number | null;
  developer: {
    id: number | null;
    name: string;
    website: string | null;
    statuses?: { status?: { name?: string } } | null;
  };
  product: { id: number | null; name: string };
  version?: { version?: string } | null;
  currentStatus?: { status?: { name?: string } } | null;
  certificationResults?: Array<{ serviceBaseUrlList?: string | null }>;
}

/** Load a previously downloaded listings file. */
export async function loadListings(type: ListingType): Promise<Listing[]> {
  const file = Bun.file(listingFile(type));
  if (!(await file.exists())) {
    throw new Error(
      `Missing ${listingFile(type)}.\nRun: bun run download -- --type ${type}`,
    );
  }
  return (await file.json()) as Listing[];
}
