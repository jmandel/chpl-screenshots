# Screenshot Hunter — CHEAP PASS (Brave image search only)

A fast, low-cost triage pass. Same acceptance bar as the full brief, but **one
cheap source only** — no expensive fallbacks.

## Acceptance criteria (unchanged — all must be true for a keeper)
1. **Full EHR application view** (sidebar/menu + header + main work area), NOT a
   cropped widget/chart/gauge/single panel.
2. **Visible patient demographics** in the image (patient banner: name, ideally
   MRN/ID and/or DOB). Demo/test patients are fine.
3. **Real working software.**

Reject logos, icons, headshots, stock photos, marketing hero graphics, pricing
tables, isolated dashboards/charts with no patient banner, and cropped widgets.

## Source — Brave image search ONLY
Use the project helper (one REST call, no browser):

```
cd /home/jmandel/hobby/ehrpatient && bun run scripts/brave-images.ts "<query>"
```

It prints a JSON array of candidate image URLs. Run it for a few queries, e.g.
`"<product> EHR screenshot"`, `"<vendor> EMR patient chart"`,
`"<product> dashboard"`. Pool + de-dup the URLs, fetch the promising ones,
**view** each, and keep only those meeting the criteria.

## DO NOT (this is what makes it cheap)
- ❌ No `yt-dlp` / YouTube / Vimeo / video downloads.
- ❌ No `ffmpeg` frame extraction.
- ❌ No headless browser / chromium / CDP.
- ❌ No deep vendor-site crawling or app-store digging.
If Brave image search yields nothing qualifying, that's a valid `found: 0`
result — **do not escalate** to any other method. Move on.

## File hygiene (strict)
- Do all scratch (candidate downloads) in `./tmp/<slug>-cheap/` (project-local;
  NOT system `/tmp`). Only COPY verified keepers into
  `data/screenshots/<slug>/`, named `01-<desc>.png`, `02-…`.
- If zero qualify: write NOTHING to `data/` (no dir, no manifest); report via
  structured output only.
- Write `data/screenshots/<slug>/manifest.json` only when `found` ≥ 1.
- Clean up `./tmp/<slug>-cheap/` when done.

## Stop when
You have 1–6 verified keepers, or Brave is exhausted. Keep it quick.
