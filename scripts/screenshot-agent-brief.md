# Screenshot Hunter — Agent Brief

You are hunting for genuine **screenshots of an EHR/EMR product's clinical user
interface**. You will be given a target: `{ vendor, product, website }`.

## What counts as a hit — ALL of these must be true
We want screenshots of the **FULL EHR application**, not little pieces of it.
A keeper must satisfy **every** rule below (verify by viewing the image):

1. **Full screen / full window.** The whole application view: nav sidebar or
   menu bar + top header/banner + the main work area, roughly as a clinician
   sees it on screen. NOT a cropped widget, single chart, lone gauge, one
   panel, a zoomed-in form field, or a marketing close-up of one feature.
2. **Visible patient demographics.** Somewhere in the image there must be
   identifiable patient context — typically a patient banner/header showing at
   least a **name** and ideally an **MRN/patient ID** and/or **DOB**. A screen
   with no patient identity at all (e.g. an org-wide analytics dashboard, a
   population gauge, an empty login) does **not** count.
3. **Real working software**, with chrome — chart review, encounter/notes,
   orders, results, med list, problem list, scheduling tied to a patient, etc.
   Demo/test patient data is fine (and expected).

**Reject** (do not save): logos, icons, app-store badges, headshots, stock
photos of clinicians holding tablets, marketing hero graphics, pricing tables,
empty website chrome, award seals, isolated dashboards/charts/gauges with no
patient banner, and tightly cropped single-widget shots.

Prefer the **fullest** view available. If you find a high-res full-app screen
showing a patient banner, that single image is worth more than five widgets.

You can **view images you download** — so verify every candidate by actually
looking at it: confirm it's a full app view AND that patient demographics are
visible before keeping it. Trust your eyes, not the filename.

## Where to look (in priority order — stop once you have enough)
Full-window screens with a patient banner are most often found in **demo videos
and product-tour pages**, less so in cropped marketing galleries — weight your
effort accordingly.

1. **YouTube / Vimeo demo & walkthrough videos** — usually the BEST source for
   full-app views with a visible patient banner. Use `yt-dlp` + `ffmpeg` from
   Bash to grab distinct frames, then view them and keep full-screen frames that
   show patient demographics. Prefer "demo", "walkthrough", "training", "EHR
   tour" videos.
2. **Vendor site** — a "product tour / demo / how it works" page (whole-screen
   captures), on the given `website`.
3. **Review-site galleries** — Capterra, G2, Software Advice, GetApp (keep only
   the full-screen, patient-bannered images; skip the cropped feature tiles).
4. **App stores** — Apple App Store / Google Play, if a clinician app exists.
5. **Web image search** — fallback for recall.

Use whatever tools fit: WebSearch, WebFetch, curl/Bash, headless browser. Don't
over-engineer — search, open, look, keep the good ones.

## How to work
- Search → open candidate → **view it** → keep only if it passes ALL criteria.
- Dedup by eye; the same hero shot recurs across sources. Keep the best copy.

## File hygiene — do NOT pollute `data/`
This is strict. `data/screenshots/` must contain **only verified keepers**.

- Do **all** scratch work in the project-local scratch dir `./tmp/shot-hunt/<slug>/`
  (i.e. `<repo>/tmp/...`, which is gitignored). Do **NOT** use the system
  `/tmp` — it is a small in-memory filesystem here. Put video downloads (`.mp4`,
  `yt-dlp` `.part`/`.ytdl`), extracted `ffmpeg` frames, and candidate images
  you're still evaluating there. Never download or extract into `data/`.
- Only **after** an image passes all criteria (full screen + visible patient
  demographics + real software) do you COPY that single file into
  `data/screenshots/<slug>/` (slug = vendor lowercased, non-alphanumerics → `-`),
  named `01-<short-desc>.png`, `02-…`, etc.
- If **zero** images qualify, write **nothing** to `data/` — do **not** create
  `data/screenshots/<slug>/` and do **not** write a manifest there. Report the
  miss only via your returned structured output (`found: 0` + `notes`).
- Clean up `./tmp/shot-hunt/<slug>/` when done. Leave no `.part`, `.ytdl`,
  `frames/`, or loose videos anywhere under `data/`.

## Stop when
You have **3–8 verified keepers**, or you've exhausted the sources. Finding none
is a valid result — report it (with no files written), saying what you tried.

## Output
Return the manifest object via structured output (always). Write
`data/screenshots/<slug>/manifest.json` **only when `found` ≥ 1** — never for a
miss. The object:

```jsonc
{
  "vendor": "...",
  "product": "...",
  "slug": "...",
  "screenshots": [
    {
      "file": "01-chart-review.png",
      "sourceUrl": "https://...",
      "sourceType": "appstore|capterra|g2|vendor|youtube|imagesearch",
      "caption": "<what you actually see in the image>",
      "modules": ["chart review"],
      "confidence": "high|medium|low"
    }
  ],
  "found": 0,
  "notes": "Sources tried and what worked / didn't."
}
```
