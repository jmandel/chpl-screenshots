export const meta = {
  name: 'hunt-and-abstract-tranche',
  description: 'Brave-API cheap hunt + Gemini abstraction over the next tranche of worklist EHRs, 5 agents always in flight. Resumable: skips already-processed EHRs.',
  phases: [
    { title: 'Select', detail: 'read worklist, take next N unprocessed' },
    { title: 'Hunt+Abstract', detail: '5-wide pool: Brave hunt then abstract each EHR' },
  ],
}

const CWD = '/home/jmandel/hobby/ehrpatient'
const BRIEF = `${CWD}/scripts/cheap-pass-brief.md`
const POOL = 5
const MAX_IMAGES = 10
const TRANCHE = (args && args.tranche) || 150   // EHRs per run

phase('Select')
const sel = await agent(
  `Pick the next tranche of UNATTEMPTED EHRs from the worklist.
1. Read ${CWD}/data/vendor-worklist.json (object with a "vendors" array, in committed random order).
2. List already-ATTEMPTED slugs: run \`ls ${CWD}/data/attempts/ 2>/dev/null\` — each file is "<slug>.json" written once per EHR we've already tried (whether or not it yielded screenshots). A slug is ATTEMPTED if it appears there.
3. Walk the vendors in order and return the FIRST ${TRANCHE} whose slug is NOT attempted, each as { vendor, product, website, slug } (product = topProducts[0], fallback vendor name).
Return { targets: [...] } (may be fewer than ${TRANCHE} if the list is nearly exhausted).
NOTE: we use data/attempts/ (not data/screenshots/) because EHRs that found zero qualifying screenshots correctly write nothing under data/screenshots — but they DO get an attempt marker, so they are not retried.`,
  {
    label: 'select-tranche', phase: 'Select',
    schema: {
      type: 'object', additionalProperties: false, required: ['targets'],
      properties: {
        targets: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['vendor', 'product', 'slug'],
            properties: { vendor: { type: 'string' }, product: { type: 'string' }, website: { type: 'string' }, slug: { type: 'string' } },
          },
        },
      },
    },
  },
)
const targets = sel?.targets ?? []
log(`Selected ${targets.length} pending EHRs`)

phase('Hunt+Abstract')

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['vendor', 'slug', 'found', 'abstracted', 'notes'],
  properties: {
    vendor: { type: 'string' }, slug: { type: 'string' },
    found: { type: 'integer' },          // screenshots kept
    abstracted: { type: 'integer' },     // images abstracted into the shard
    candidatesExamined: { type: 'integer' },
    notes: { type: 'string' },
  },
}

const prompt = (t) => `You handle ONE EHR end-to-end: a cheap Brave-only screenshot hunt, then Gemini abstraction of what you found.

STEP 1 — HUNT (cheap, Brave image search ONLY). Read and follow ${BRIEF} exactly. NO yt-dlp/video, NO ffmpeg, NO headless browser, NO deep crawling. Get candidates with:
  cd ${CWD} && bun run scripts/brave-images.ts "<query>"
(This now uses the official Brave API via BRAVE_API_KEY — reliable. Run a few queries: "${t.product} EHR screenshot", "${t.vendor} EMR patient chart", "${t.product} dashboard". Pool + de-dup URLs.)
ACCEPTANCE (all must hold for a keeper): FULL EHR application view (sidebar/menu + header + main work area) AND visible patient demographics (name, ideally MRN/ID and/or DOB). Reject widgets/charts/logos/stock/marketing. Demo/test patients fine.
Download candidates into ${CWD}/tmp/${t.slug}-cheap/ (project-local scratch, NOT system /tmp), VIEW each, keep at most ${MAX_IMAGES}. Copy keepers to ${CWD}/data/screenshots/${t.slug}/ named 01-*.png, 02-*.png, ... If ZERO qualify: write NOTHING under data/, set found=0, abstracted=0, and STOP (skip step 2). Write data/screenshots/${t.slug}/manifest.json only if found>=1. Clean up your tmp dir.

STEP 2 — ABSTRACT (only if found>=1). Run the Gemini abstraction on YOUR kept images into a per-EHR shard:
  cd ${CWD} && bun run scripts/abstract-batch.ts --out data/abstractions/${t.slug}.ndjson data/screenshots/${t.slug}/*.png
This appends one JSON record per image (tokens, price, bounding boxes, the abstraction) to that shard. Capture how many were abstracted from its output (processed=N). Do NOT touch data/abstractions.ndjson or any other slug's files.

STEP 3 — MARK ATTEMPTED (ALWAYS — even if found=0). This is the resume ledger so we never retry this EHR. Run:
  cd ${CWD} && mkdir -p data/attempts && printf '%s' '{"slug":"${t.slug}","found":<FOUND>,"abstracted":<ABSTRACTED>}' > data/attempts/${t.slug}.json
substituting the real numbers. (data/attempts/ is the ONLY thing you may write under data/ for a zero-yield miss.)

TARGET: vendor="${t.vendor}" product="${t.product}" website=${t.website || '(unknown)'} slug=${t.slug}

Return: found (#kept), abstracted (#records written), candidatesExamined, and a short notes line.`

const results = new Array(targets.length)
let next = 0, completed = 0
async function worker(wid) {
  while (true) {
    const i = next++
    if (i >= targets.length) return
    const t = targets[i]
    try { results[i] = await agent(prompt(t), { label: `ehr:${t.slug}`, phase: 'Hunt+Abstract', schema: SCHEMA }) }
    catch { results[i] = null }
    completed++
    const r = results[i]
    log(`[w${wid}] ${completed}/${targets.length} ${t.slug}: found=${r?.found ?? 'err'} abstracted=${r?.abstracted ?? 0}`)
  }
}
await Promise.all(Array.from({ length: POOL }, (_, k) => worker(k + 1)))

const clean = results.filter(Boolean)
const withHits = clean.filter((r) => r.found > 0)
const totalShots = clean.reduce((n, r) => n + (r.found || 0), 0)
const totalAbs = clean.reduce((n, r) => n + (r.abstracted || 0), 0)
log(`Done: ${withHits.length}/${targets.length} EHRs yielded screenshots; ${totalShots} kept, ${totalAbs} abstracted`)
return {
  ehrsProcessed: clean.length,
  ehrsWithHits: withHits.length,
  totalScreenshots: totalShots,
  totalAbstracted: totalAbs,
  perEhr: clean.map((r) => ({ slug: r.slug, found: r.found, abstracted: r.abstracted })),
}
