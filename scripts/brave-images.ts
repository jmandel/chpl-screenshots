/**
 * Harvest image-search candidates from Brave Images using a PLAIN REST call —
 * no browser, no CDP, no WebSocket.
 *
 * Brave's results page is a SvelteKit app; its data route returns the full
 * result set as JSON:
 *     GET https://search.brave.com/images/__data.json?q=<query>
 * We just fetch that and pull out the original (non-proxy) image URLs, which are
 * the actual candidate screenshots hosted on third-party / vendor sites.
 *
 * Usage:
 *   bun run scripts/brave-images.ts "maximeyes ehr screenshot"
 *   bun run scripts/brave-images.ts "maximeyes ehr screenshot" --thumbs   # also list Brave proxy thumbs
 *
 * Prints a JSON array of candidate image URLs to stdout.
 */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const IMG_RE = /^https?:\/\/.+\.(png|jpe?g|webp)(\?.*)?$/i;

/** Recursively collect every string in a JSON value. */
function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const v of node) strings(v, out);
  else if (node && typeof node === "object") for (const v of Object.values(node)) strings(v, out);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Preferred path: the official Brave Image Search API (requires BRAVE_API_KEY).
 * Reliable, structured, and the right way to do this — no scraping/rate hacks.
 * Docs: https://api.search.brave.com/app/documentation/image-search
 */
async function viaApi(query: string, opts: { thumbs?: boolean; count?: number; retries?: number }): Promise<string[]> {
  const key = process.env.BRAVE_API_KEY!;
  const u = new URL("https://api.search.brave.com/res/v1/images/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(Math.min(opts.count ?? 50, 100)));
  u.searchParams.set("safesearch", "off");

  const retries = opts.retries ?? 4;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(attempt * 1200 + Math.floor(Math.random() * 600));
    const res = await fetch(u, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    }).catch(() => null);
    if (!res) continue;
    if (res.status === 429 || res.status >= 500) continue; // rate-limited -> back off
    if (!res.ok) throw new Error(`Brave API ${res.status} ${res.statusText}`);
    const json: any = await res.json().catch(() => null);
    const results: any[] = json?.results ?? [];
    const urls = results
      .map((r) => (opts.thumbs ? r?.thumbnail?.src : r?.properties?.url || r?.thumbnail?.src))
      .filter((s): s is string => typeof s === "string");
    return [...new Set(urls)];
  }
  throw new Error(`Brave API rate-limited after ${retries + 1} attempts`);
}

/** Fallback: scrape the SvelteKit __data.json (no key needed, but flaky). */
async function viaScrape(query: string, opts: { thumbs?: boolean; retries?: number }): Promise<string[]> {
  const url = `https://search.brave.com/images/__data.json?q=${encodeURIComponent(query)}`;
  const retries = opts.retries ?? 4;
  let json: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(attempt * 1500 + Math.floor(Math.random() * 800));
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } }).catch(() => null);
    if (!res) continue;
    if (res.status === 429 || res.status >= 500) continue;
    if (!res.ok) throw new Error(`Brave returned ${res.status} ${res.statusText}`);
    const parsed = await res.json().catch(() => null);
    if (parsed && strings(parsed).some((s) => /\.(png|jpe?g|webp)/i.test(s))) { json = parsed; break; }
  }
  if (json == null) throw new Error(`Brave returned no usable results after ${retries + 1} attempts (rate-limited?)`);
  const all = strings(json);
  const isProxyOrChrome = (u: string) => /search\.brave\.com/i.test(u) || /favicon|logo|sprite|apple-touch/i.test(u);
  const result = opts.thumbs
    ? all.filter((u) => /imgs?\.search\.brave\.com/i.test(u))
    : all.filter((u) => IMG_RE.test(u) && !isProxyOrChrome(u));
  return [...new Set(result)];
}

/**
 * Simple image search. Uses the official Brave API when BRAVE_API_KEY is set
 * (Bun auto-loads it from .env), otherwise falls back to scraping.
 */
export async function braveImages(
  query: string,
  opts: { thumbs?: boolean; count?: number; retries?: number } = {},
): Promise<string[]> {
  return process.env.BRAVE_API_KEY ? viaApi(query, opts) : viaScrape(query, opts);
}

async function main() {
  const argv = Bun.argv.slice(2);
  const query = argv.filter((a) => !a.startsWith("--"))[0];
  if (!query) {
    console.error('Usage: bun run scripts/brave-images.ts "<query>" [--thumbs]');
    process.exit(1);
  }
  const urls = await braveImages(query, { thumbs: argv.includes("--thumbs") });
  console.log(JSON.stringify(urls, null, 2));
  console.error(`(${urls.length} candidates for "${query}")`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("✗", err.message);
    process.exit(1);
  });
}
