/**
 * Aggregate the `additionalFields` (schema-gap discoveries) across all abstraction
 * shards into a per-category label/value summary — clean input for the analysis
 * workflow that proposes schema promotions / taxonomies / labeling guidance.
 *
 * Writes data/experiments/additional-fields/summary.json (+ per-category files).
 * Usage: bun run scripts/additional-fields-stats.ts
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./chpl.ts";

const OUT = join(DATA_DIR, "experiments", "additional-fields");
mkdirSync(OUT, { recursive: true });

const norm = (s: any) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

type Lab = { label: string; count: number; values: string[]; valueSet: Set<string> };
const byCat: Record<string, Map<string, Lab>> = {};
let total = 0, records = 0, recordsWithAF = 0;

for (const f of readdirSync(join(DATA_DIR, "abstractions")).filter((x) => x.endsWith(".ndjson"))) {
  for (const line of readFileSync(join(DATA_DIR, "abstractions", f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: any; try { rec = JSON.parse(line); } catch { continue; }
    records++;
    const af = rec.output?.additionalFields;
    if (!Array.isArray(af) || !af.length) continue;
    recordsWithAF++;
    const KNOWN = new Set(["patient", "provider", "encounter", "order", "other"]);
    for (const e of af) {
      total++;
      const cn = norm(e.category);
      const cat = KNOWN.has(cn) ? cn : "other";
      const lk = norm(e.label);
      (byCat[cat] ??= new Map());
      const m = byCat[cat];
      const cur = m.get(lk) ?? { label: e.label ?? "", count: 0, values: [], valueSet: new Set() };
      cur.count++;
      const v = String(e.value ?? "").trim();
      if (v && !cur.valueSet.has(v) && cur.valueSet.size < 12) { cur.valueSet.add(v); cur.values.push(v); }
      m.set(lk, cur);
    }
  }
}

const summary: any = { totalEntries: total, records, recordsWithAdditionalFields: recordsWithAF, byCategory: {} };
for (const [cat, m] of Object.entries(byCat)) {
  const labels = [...m.values()]
    .map((l) => ({ label: l.label, count: l.count, sampleValues: l.values }))
    .sort((a, b) => b.count - a.count);
  summary.byCategory[cat] = { totalEntries: labels.reduce((s, l) => s + l.count, 0), distinctLabels: labels.length, labels };
  writeFileSync(join(OUT, `summary-${cat}.json`), JSON.stringify({ category: cat, ...summary.byCategory[cat] }, null, 2));
}
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`additionalFields: ${total} entries across ${recordsWithAF}/${records} records`);
for (const [cat, c] of Object.entries(summary.byCategory))
  console.log(`  ${cat}: ${(c as any).totalEntries} entries, ${(c as any).distinctLabels} distinct labels`);
console.log(`\nTop labels overall:`);
const all = Object.values(byCat).flatMap((m) => [...m.values()]);
all.sort((a, b) => b.count - a.count);
for (const l of all.slice(0, 25)) console.log(`  ${l.count.toString().padStart(4)}  ${l.label}`);
