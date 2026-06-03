# CHPL Screenshots

Find real screenshots of certified EHR products, abstract patient/EHR context out
of each with a vision model, and review/share the results.

Starting from the ONC **CHPL** (Certified Health IT Product List), we sweep every
certified developer, hunt genuine product screenshots, run each through Google
**Gemini 3.5 Flash** (structured output) to extract patient demographics + EHR
context with bounding boxes, and present everything in a static web viewer with a
coverage report and a hash-based filter system.

Runtime: **Bun + TypeScript**. No build step for the app (vanilla JS/CSS).

---

## TL;DR

```bash
bun install
bun run download                 # CHPL active-product dump → data/chpl-active-listings.json
bun run worklist                 # randomized, committed worklist of 469 developers
# (hunting + abstraction are run as multi-agent workflows — see "Pipelines")
bun run viewer                   # review at http://localhost:5599
bun run build                    # static site → ./dist  (deploy to GH Pages, etc.)
```

Current corpus: **469 developers swept**, **238 with screenshots**, **828 screenshots
abstracted**, ~**$12.44** total Gemini cost (~$0.015/screenshot).

---

## Pipeline

```
CHPL bulk dump ──▶ randomized worklist (469 developers) ──▶ pick next tranche
                                                                  │
                          ┌───────────── 5-agent worker pool (per EHR) ─────────────┐
                          │  Brave image search (REST) → view candidates →          │
                          │  keep full-screen + patient-banner shots →              │
                          │  Gemini abstraction (structured output) → per-EHR shard │
                          └─────────────────────────────────────────────────────────┘
                                                                  │
            data/screenshots/<slug>/*.png   +   data/abstractions/<slug>.ndjson   +   data/attempts/<slug>.json
                                                                  │
                                                  viewer (bun run viewer)  ·  static build (bun run build)
```

### Stages
1. **CHPL download** (`bun run download`) — the entire active certified-product
   collection as JSON. Two non-obvious requirements baked into the script:
   `format=json` (server default is csv) and `Accept: */*` (sending
   `application/json` makes content negotiation 500).
2. **Worklist** (`bun run worklist`) — groups listings by developer, computes each
   developer's top products, and writes a **randomly-shuffled, seeded** worklist
   (`data/vendor-worklist.json`) so we can work the long tail one tranche at a time.
3. **Screenshot hunt** — agents follow `scripts/cheap-pass-brief.md`: get candidates
   from Brave image search (REST, `scripts/brave-images.ts`), **view** each, and keep
   only **full-application screens with visible patient demographics**. Cheap-pass =
   Brave only (no video/headless-browser). Scratch stays in `./tmp`, only verified
   keepers land in `data/screenshots/<slug>/`.
4. **Abstraction** (`scripts/abstract-screenshot.ts`, batched by
   `scripts/abstract-batch.ts`) — each screenshot → schema-shaped JSON via Gemini
   (see "Abstraction schema"). One NDJSON record per image, with token usage,
   price, and pixel-space bounding boxes.
5. **Viewer / static build** — review live or export a static site.

### Multi-agent workflows
The hunt+abstract sweep runs as a workflow (`workflows/hunt-and-abstract-150.js`)
with a **fixed pool of 5 agents** drawing from a shared queue (steady 5 in flight,
refilled as each finishes). Full design notes: **`docs/workflows.md`**. Key points:

- **Resumable / tranches.** Each agent writes `data/attempts/<slug>.json` *whether
  or not* it found anything, so re-running the workflow skips already-attempted
  developers and grabs the next tranche. The full 469 was done as 150+150+150+19.
- **Attempt ledger, not screenshots.** A found-0 developer writes no screenshots,
  so "processed" is keyed off `data/attempts/`, not `data/screenshots/` — otherwise
  zero-yield developers would be retried forever.

---

## Abstraction schema (v2)

Every extractable field is a **`{ value, box }`** pair — co-locating the box with
the value forces the model to localize each thing it reads. The full schema lives
in `abstraction-prompt.md`; the runnable Gemini version is in
`scripts/abstract-screenshot.ts`.

- `systemMetadata`: `systemName`, `clinicalSpecialty`, `activeFunction`, `uiSection`
  (each `{value,box}`), plus classifiers **`isEhrScreen`** (bool),
  **`patientScope`** (`single`|`multiple`|`none`), **`singlePatientConfidence`**
  (0–1, "how sure this is an EHR screen about a single patient").
- `patient`: `patientId`, `fullName`/`firstName`/`lastName`, `dateOfBirth`, `age`,
  `sex`, `genderIdentity`, `address`, `phone`, `maritalStatus`,
  `preferredLanguage`, `race`, `ethnicity` (each `{value,box}`).
- `encounterContext`: `encounterDate`, `encounterType`.
- `additionalFields[]`: clearly-labeled patient/provider/visit data **not** in the
  schema — our schema-gap discovery channel (`{category,label,value,box}`).

Boxes are normalized 0–1000 (Gemini convention); the script converts each to
pixel-space `boxPx{x,y,width,height}` using the image's real dimensions.

**Structured output:** we pass the schema to Gemini as `responseSchema` +
`responseMimeType:"application/json"`. That's **constrained decoding** (enforced
shape/enums/required), *in addition to* the prose `systemInstruction`. That's why
output is always valid JSON on-schema.

Pricing baked in: `gemini-3.5-flash` = **$1.50 / 1M input, $9.00 / 1M output**.

---

## Analyses

### Brave-REST vs. standard hunting
Image-search-via-REST vs. a general agent (vendor site + review galleries + YouTube
frame extraction). **Tied on yield (13 = 13 across 3 seeds)** but Brave examined
~5× fewer candidates and used trivial compute, while the standard approach burned
100–215 MB of video downloads per seed. → cheap pass = Brave first.

### Prompt / cost optimization (`scripts/prompt-experiment.ts`)
12 single-patient screenshots × variants (lean vs terse schema, image size,
**thinking budget**), ≤100 Gemini calls; results in
`data/experiments/prompt-opt/`.

- **`thinkingBudget: 0` is the biggest lever.** Default thinking silently adds
  ~700 output tokens (billed as output @ $9/M). Disabling it: **$0.0093 → $0.0032
  per screenshot** with no accuracy loss.
- **Drop boxes + additionalFields (data-only schema)** → output ~160 vs baseline's
  ~1328 tokens.
- **Downscaling the image barely helps** input tokens (Gemini normalizes image
  resolution) and *hurts* tiny-digit OCR — so keep full-res.
- **Terse short-keys backfired** (output exploded, accuracy dropped). Use readable keys.
- **Net cheap-pass** = lean schema + `thinkingBudget:0` + full-res ≈ **$0.0032/shot,
  ~4.6× cheaper** than the full v2 run, demographics intact (DOB/sex/scope 100%,
  name/systemName ~92%). `patientId` "disagreements" vs the full run are single-digit
  OCR on low-res MRNs, shared by both configs — not a cheap-pass regression.
- Trade-off: lean loses bounding boxes + schema-gap discovery. Use **full v2** for
  the annotated viewer / discovery, **lean+think=0** for bulk extraction.

---

## Viewer

`bun run viewer` → http://localhost:5599

- **List**: gallery of screenshots, each card showing CHPL vendor, product(s),
  detected active function, patient name, single-patient-confidence badge, cost.
- **Detail**: the screenshot with **bounding-box overlays** (force-separated labels
  + leader lines), CHPL **seed** (vendor/product/website) side-by-side with the
  **detected** metadata, and the **Additional Fields** the model surfaced. Hover a
  field ↔ its box highlight in sync. Toggle all-boxes vs. hover-only. ←/→ navigate.
- **Coverage report** (the ⓘ button, `#report`): headline tiles, a **funnel**
  (developers tried → any screenshot → ≥1 EHR screen → ≥1 single-patient →
  single-patient ≥0.8 conf), a **confidence distribution**, and a **cost-per-
  screenshot distribution**. Bars/stages are **clickable** → open the filtered list.

### Filters (hash-encoded JSON)
The URL hash carries a filter object; the list shows only matching screenshots,
with a banner describing the filter + a ✕ to clear. Examples:

```
#{"systemName":"epic"}
#{"patientName":"smith"}
#{"confMin":0.9}
#{"patientScope":"multiple"}
#{"isEhrScreen":true}
#{"vendor":"netsmart"}
#{"costMax":0.008}
#{"field":"patient.dateOfBirth","present":true}
#{"field":"encounterContext.encounterType","contains":"colonoscopy"}
```
Keys AND together. Supported: `confMin`/`confMax`, `isEhrScreen`, `patientScope`,
`systemName`, `patientName`, `vendor`, `costMin`/`costMax`, and a generic
`field` + (`present` | `contains` | `equals`). Filters persist into the detail view
and prev/next navigates within the filtered subset.

---

## Building the static site

```bash
bun run build            # → ./dist : index.html, app.js, style.css,
                         #   records.json, report.json, screenshots/<slug>/*.png
```
`dist/` is a pure static site (no server) — deploy to **GitHub Pages, S3, Netlify**.
The frontend prefers the static `records.json`/`report.json`/`screenshots/…` and
falls back to the dev server's `/api` + `/img` endpoints, so the *same* `app.js`
works live and static.

### Single-file share + selection flags
`--single` inlines CSS/JS/records/report **and every image (as data URIs)** into one
`dist/standalone.html` — openable offline by double-click. The full corpus is ~320 MB,
so trim it with selection flags (composed in order: **filter → per-vendor → vendor sample**):

| Flag | Meaning |
|---|---|
| `--filter '<json>'` | Keep only screenshots matching the **web app's filter JSON** (same keys as the viewer hash above). |
| `--per-vendor <N>` | At most **N screenshots per vendor**, choosing the **most-confident single-patient** shots first, then working down. |
| `--sample-vendors <N>` | Randomly keep only **N vendors** (thins payload across EHRs). |
| `--seed <N>` | Seed for `--sample-vendors` (default 1337; reproducible). |

```bash
# one best screenshot per single-patient, high-confidence vendor, all-in-one file (~81 MB)
bun run build -- --single --filter '{"patientScope":"single","confMin":0.9}' --per-vendor 1

# a small, emailable sample: 40 random vendors, ≤1 shot each
bun run build -- --single --sample-vendors 40 --per-vendor 1

# just one vendor's screenshots, static folder
bun run build -- --filter '{"vendor":"epic"}'
```

---

## Scripts

| `bun run …` | Script | Purpose |
|---|---|---|
| `download` | `scripts/download-chpl.ts` | CHPL bulk product dump (json, `Accept: */*`) |
| `worklist` | `scripts/build-worklist.ts` | Randomized, committed developer worklist |
| `sample` | `scripts/sample-vendors.ts` | Random vendor sample + top products |
| `abstract <img>` | `scripts/abstract-screenshot.ts` | One screenshot → schema JSON (+ pixel boxes) |
| `abstract:batch` | `scripts/abstract-batch.ts` | Batch → NDJSON shard (tokens, price, `--out`) |
| `reabstract` | `scripts/reabstract-v1.ts` | Re-abstract any legacy v1 shards to v2 |
| `backfill-attempts` | `scripts/backfill-attempts.ts` | Mark first-N worklist developers as attempted |
| `clean` | `scripts/clean-screenshots.ts` | Sweep `data/screenshots` to keepers-only |
| `viewer` | `scripts/viewer-server.ts` | Review UI + `/api/records`, `/api/report`, `/img` |
| `build` | `scripts/build-static.ts` | Static site (+ `--single`, selection flags) |
| — | `scripts/brave-images.ts` | Brave image-search helper (REST; `BRAVE_API_KEY`) |
| — | `scripts/report-data.ts` | Shared pure data layer (records + report + filters) |
| — | `scripts/prompt-experiment.ts` | Cost/accuracy optimization experiment |

## Data layout

| Path | What | Committed? |
|---|---|---|
| `data/chpl-active-listings.json` | Full CHPL active dump (~150 MB) | gitignored (`bun run download`) |
| `data/vendor-worklist.json` | 469 developers, committed random order + status | yes |
| `data/screenshots/<slug>/*.png` | Verified keeper screenshots | yes |
| `data/abstractions/<slug>.ndjson` | Per-developer abstraction shards | yes |
| `data/abstractions.ndjson` | Optional merged file (viewer reads shards too) | yes |
| `data/attempts/<slug>.json` | Resume ledger (one per attempted developer) | yes |
| `tmp/` | Agent scratch (downloads/frames) — never under `data/` | gitignored |
| `dist/` | Built static site | gitignored |

## Config / keys

Bun auto-loads `.env` from the project root:
- `GEMINI_API_KEY` — Google Gemini (abstraction).
- `BRAVE_API_KEY` — Brave Search image API (hunting; falls back to scrape if unset).
- `CHPL_API_KEY` — public CHPL key (a default is baked in).
