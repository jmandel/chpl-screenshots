export const meta = {
  name: 'cheap-pass-100',
  description: 'Cheap pass (Brave image search only) over 100 random EHR products, 5 agents always in flight',
  phases: [
    { title: 'Select', detail: 'read worklist, take 100 pending' },
    { title: 'Cheap pass', detail: '5-wide worker pool, Brave-only' },
  ],
}

const CWD = '/home/jmandel/hobby/ehrpatient'
const BRIEF = `${CWD}/scripts/cheap-pass-brief.md`
const POOL = 5

phase('Select')
const sel = await agent(
  `Read ${CWD}/data/vendor-worklist.json (JSON with a "vendors" array, already in a committed random order). Return the FIRST 100 entries whose status is "pending", preserving order. For each return { vendor, product, website, slug } where product = topProducts[0] (fallback to the vendor name if empty) and website/slug come straight from the entry. Return { targets: [...] }.`,
  {
    label: 'select-100',
    phase: 'Select',
    schema: {
      type: 'object', additionalProperties: false, required: ['targets'],
      properties: {
        targets: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['vendor', 'product', 'slug'],
            properties: {
              vendor: { type: 'string' }, product: { type: 'string' },
              website: { type: 'string' }, slug: { type: 'string' },
            },
          },
        },
      },
    },
  },
)
const targets = sel?.targets ?? []
log(`Selected ${targets.length} pending products for the cheap pass`)

phase('Cheap pass')

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['vendor', 'slug', 'found', 'candidatesExamined', 'screenshots', 'notes'],
  properties: {
    vendor: { type: 'string' }, product: { type: 'string' }, slug: { type: 'string' },
    found: { type: 'integer' }, candidatesExamined: { type: 'integer' }, notes: { type: 'string' },
    screenshots: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'sourceUrl', 'caption', 'isFullScreen', 'hasPatientDemographics'],
        properties: {
          file: { type: 'string' }, sourceUrl: { type: 'string' }, caption: { type: 'string' },
          isFullScreen: { type: 'boolean' }, hasPatientDemographics: { type: 'boolean' },
        },
      },
    },
  },
}

const cheapPrompt = (t) => `CHEAP PASS (Brave image search ONLY). Read and follow your instructions at ${BRIEF} exactly.

This pass is deliberately cheap: NO yt-dlp/YouTube/video, NO ffmpeg, NO headless browser/chromium, NO deep site crawling or app-store digging. If Brave image search yields nothing qualifying, return found:0 and STOP — do not escalate.

ACCEPTANCE (all must hold for a keeper): FULL EHR application view (sidebar/menu + header + main work area) AND visible patient demographics (patient banner: name, ideally MRN/ID and/or DOB). Demo/test patients fine. Reject widgets/charts/gauges/logos/stock photos/marketing/pricing.

CANDIDATES: cd ${CWD} && bun run scripts/brave-images.ts "<query>" — run a few queries for this product (e.g. "${t.product} EHR screenshot", "${t.vendor} EMR patient chart", "${t.product} dashboard"), pool + de-dup the printed URLs, fetch the promising ones into ${CWD}/tmp/${t.slug}-cheap/, VIEW each, keep only qualifiers.

TARGET: vendor="${t.vendor}" product="${t.product}" website=${t.website || '(unknown)'} slug=${t.slug}

FILE HYGIENE (strict): scratch ONLY in ${CWD}/tmp/${t.slug}-cheap/ (project-local, NOT system /tmp). Copy keepers to ${CWD}/data/screenshots/${t.slug}/ named 01-*.png etc. If zero qualify, write NOTHING under data/ (no dir, no manifest). Write data/screenshots/${t.slug}/manifest.json only when found>=1. Clean up your tmp dir.

Return the manifest via structured output; set candidatesExamined to how many candidate image URLs you actually inspected.`

const results = new Array(targets.length)
let next = 0
let completed = 0

async function worker(wid) {
  while (true) {
    const i = next++
    if (i >= targets.length) return
    const t = targets[i]
    try {
      results[i] = await agent(cheapPrompt(t), { label: `cheap:${t.slug}`, phase: 'Cheap pass', schema: SCHEMA })
    } catch (e) {
      results[i] = null
    }
    completed++
    const f = results[i]?.found
    log(`[w${wid}] ${completed}/${targets.length} ${t.slug}: ${f == null ? 'error' : 'found=' + f}`)
  }
}

await Promise.all(Array.from({ length: POOL }, (_, k) => worker(k + 1)))

const clean = results.filter(Boolean)
const hits = clean.filter((r) => r.found > 0)
const totalShots = clean.reduce((n, r) => n + (r.found || 0), 0)
const examined = clean.reduce((n, r) => n + (r.candidatesExamined || 0), 0)
log(`Cheap pass done: ${hits.length}/${targets.length} products yielded screenshots; ${totalShots} keepers from ~${examined} candidates examined`)
return {
  productsProcessed: clean.length,
  productsWithHits: hits.length,
  totalScreenshots: totalShots,
  candidatesExamined: examined,
  perProduct: clean.map((r) => ({ slug: r.slug, found: r.found, examined: r.candidatesExamined })),
}
