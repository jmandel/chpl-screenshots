# Screenshot Hunt + Abstraction — Workflow Spec

How the multi-agent runs work, so we don't have to reverse-engineer them later.
Runnable copies of the orchestration scripts live in `workflows/`.

## Pipeline at a glance

```
CHPL bulk dump ──> randomized worklist (469 vendors) ──> pick N pending
                                                              │
                                  ┌───────────── 5-agent worker pool ─────────────┐
                                  │  per EHR:  Brave cheap hunt → save keepers →   │
                                  │            Gemini abstraction → per-EHR shard  │
                                  └───────────────────────────────────────────────┘
                                                              │
                         data/screenshots/<slug>/*.png   +   data/abstractions/<slug>.ndjson
                                                              │
                                                       viewer (bun run viewer)
```

## Data layout

| Path | What | Committed? |
|---|---|---|
| `data/chpl-active-listings.json` | Full CHPL active-product dump (~150 MB) | gitignored (re-fetch: `bun run download`) |
| `data/vendor-worklist.json` | 469 vendors in a **committed random order** + per-entry status | yes |
| `data/screenshots/<slug>/NN-*.png` | Verified keeper screenshots (full app + patient demographics) | yes |
| `data/screenshots/<slug>/manifest.json` | Hunt manifest (only when found ≥ 1) | yes |
| `data/abstractions/<slug>.ndjson` | Per-EHR abstraction shard (1 record/image) | yes |
| `data/abstractions.ndjson` | Optional merged file (viewer reads shards too) | yes |
| `data/attempts/<slug>.json` | **Resume ledger** — written once per EHR we tried, *even if it found 0* | yes |
| `tmp/` | Agent scratch (video/frames/candidates) — **never** under `data/` | gitignored |

`slug` = vendor name lowercased, non-alphanumerics → `-`. It is the join key
between screenshots, shards, and the worklist seed.

## The 5-agent worker pool (mental model)

Not "one new agent per task." It's **5 long-lived loops sharing one counter**;
when a loop's agent finishes, that same loop grabs the next item. Steady-state =
exactly 5 subagents in flight, continuously refilled, no batch barrier.

```js
const results = new Array(targets.length)
let next = 0
async function worker() {
  while (true) {
    const i = next++                 // atomically claim the next index
    if (i >= targets.length) return
    results[i] = await agent(prompt(targets[i]))   // a FRESH subagent per EHR
  }
}
await Promise.all(Array.from({ length: 5 }, worker))
```

- Each `agent()` is a brand-new subagent with its own context; nothing persists
  between iterations. The "worker" is just the JS loop in the orchestrator.
- The pool size (5) is set explicitly. The framework *also* caps concurrent
  `agent()` calls at `min(16, cores-2)` and 1000 agents total — that's a ceiling
  above our 5, not the binding limit here.
- Contrast: `parallel(thunks)` starts everything at once (throttled to the cap)
  and is a **barrier** (awaits all). `pipeline(items, ...stages)` flows items
  through stages. We hand-rolled the pool to pin concurrency at 5 with
  continuous refill and live shard output (no barrier).

## Per-EHR agent task (`workflows/hunt-and-abstract-150.js`)

1. **Select phase** — one agent reads `data/vendor-worklist.json` and returns the
   first 150 `pending` entries (workflow scripts can't read files themselves).
2. **Hunt+Abstract phase** — 5-agent pool; each agent, for one EHR:
   - **Hunt (cheap, Brave only):** follows `scripts/cheap-pass-brief.md`. Gets
     candidates via `bun run scripts/brave-images.ts "<query>"` (official Brave
     API when `BRAVE_API_KEY` is set, else `__data.json` scrape). **No** yt-dlp /
     video / ffmpeg / headless browser. Views each candidate; keeps ≤10 that are
     a FULL EHR app view **with visible patient demographics**.
   - **Hygiene:** scratch only in `tmp/<slug>-cheap/`; copy keepers to
     `data/screenshots/<slug>/`; if zero qualify, write **nothing** under `data/`.
   - **Abstract:** if found ≥ 1, runs
     `bun run scripts/abstract-batch.ts --out data/abstractions/<slug>.ndjson data/screenshots/<slug>/*.png`
     (own shard → no concurrent-append corruption).

## Supporting scripts

| Script | npm | Role |
|---|---|---|
| `scripts/download-chpl.ts` | `bun run download` | Bulk CHPL JSON download (`format=json`, `Accept: */*`) |
| `scripts/build-worklist.ts` | `bun run worklist` | Randomized, committed worklist (seeded) |
| `scripts/brave-images.ts` | — | Image candidates (Brave API ▸ scrape fallback), retry/backoff |
| `scripts/abstract-screenshot.ts` | `bun run abstract <img>` | One screenshot → schema-shaped JSON (Gemini 3.5 Flash) + pixel boxes |
| `scripts/abstract-batch.ts` | `bun run abstract:batch` | Batch → NDJSON (tokens, price, boxes); `--out`, skips done |
| `scripts/clean-screenshots.ts` | `bun run clean` | Sweep `data/screenshots` to keepers-only |
| `scripts/viewer-server.ts` | `bun run viewer` | Review UI (joins seed, boxes, confidence) |

## Re-running / resuming / tranches

- `workflows/hunt-and-abstract-150.js` is **resumable by design**: its Select
  step skips any slug present in `data/attempts/` (the attempt ledger), then
  takes the next `args.tranche` (default 150) in worklist order. So you process
  the whole list **one tranche at a time** by just re-invoking it.
  `Workflow({ scriptPath: "workflows/hunt-and-abstract-150.js" })`
- **Why the attempt ledger, not screenshot dirs:** an EHR that finds zero
  qualifying screenshots writes nothing under `data/screenshots/`, so keying
  "processed" off screenshots would retry every zero-yield EHR forever. Each
  agent therefore writes `data/attempts/<slug>.json` regardless of outcome.
  (The pre-ledger first tranche is backfilled via
  `bun run scripts/backfill-attempts.ts <N>`.)
- The worklist has 469 vendors, so a full sweep ≈ 150 + 150 + 150 + 19.
- Resume a paused/edited run (cached unchanged agents):
  `Workflow({ scriptPath, resumeFromRunId: "wf_..." })`.
- The per-EHR abstraction also skips images already in its shard, so re-runs top up.

## Abstraction output (per image, in each shard)

`{ ts, file, model, imageSize, usage{in/out/total}, price{...}, output }` where
`output` = `systemMetadata` (incl. `isEhrScreen`, `patientScope`,
`singlePatientConfidence`), `patient`, `encounterContext`, `additionalFields`
(schema-gap discoveries), and `annotations` (per-value bounding boxes, normalized
0–1000 → `boxPx` in image pixels). Pricing: gemini-3.5-flash $1.50/$9.00 per 1M.
