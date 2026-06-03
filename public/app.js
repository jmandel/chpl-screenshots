"use strict";

let records = [];
let current = -1; // index in detail view, -1 = list
let activeFilter = null; // parsed filter object, or null
// Box visibility mode: true = show all boxes always, false = only on hover.
let boxesShowAll = localStorage.getItem("boxesShowAll") !== "0";

const el = (id) => document.getElementById(id);
const listView = el("listView");
const detailView = el("detailView");
const reportView = el("reportView");
const gallery = el("gallery");
const backBtn = el("backBtn");
const topbarRight = el("topbarRight");

const detailImg = el("detailImg");
const overlay = el("overlay");
const jsonPane = el("jsonPane");

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function vendorOf(file) {
  const m = /screenshots\/([^/]+)\/([^/]+)$/.exec(file || "");
  return m ? `${m[1]}/${m[2]}` : (file || "");
}
function fmtUSD(n) {
  if (n == null) return "—";
  return "$" + Number(n).toFixed(4);
}
function fmtTok(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}
function fmtConf(n) {
  if (n == null) return "—";
  return Math.round(Number(n) * 100) + "%";
}
function webLink(url) {
  if (!url) return "—";
  const safe = String(url);
  if (!/^https?:\/\//i.test(safe)) return esc(safe);
  let host = safe;
  try { host = new URL(safe).host; } catch {}
  return `<a href="${esc(safe)}" target="_blank" rel="noreferrer">${esc(host)}</a>`;
}
function confClass(n) {
  if (n == null) return "";
  if (n >= 0.75) return "conf-hi";
  if (n >= 0.4) return "conf-mid";
  return "conf-lo";
}

/* ---------------- data source (static-first, dev-server fallback, single-file embed) ---------------- */
const EMBED = window.__EHR__ || null; // single-file bundle: { records, report, images }
async function fetchJson(staticPath, apiPath) {
  try { const r = await fetch(staticPath); if (r.ok) return await r.json(); } catch {}
  const r = await fetch(apiPath); return await r.json();
}
async function fetchRecords() { return EMBED ? EMBED.records : fetchJson("records.json", "/api/records"); }
async function fetchReport() { return EMBED ? EMBED.report : fetchJson("report.json", "/api/report"); }
function relPath(r) { return (r.file || "").replace(/^data\//, ""); } // screenshots/<slug>/<f>
function imgSrc(r) { return EMBED && EMBED.images ? (EMBED.images[relPath(r)] || "") : relPath(r); }
function imgFallback(r) { return "/img?file=" + encodeURIComponent(r.file); }
// wire an <img> element to try the static path, then fall back to the dev endpoint
function setImg(img, r) {
  if (EMBED) { img.src = imgSrc(r); return; }
  img.dataset.fallback = imgFallback(r);
  img.onerror = function () { this.onerror = null; this.src = this.dataset.fallback; };
  img.src = imgSrc(r);
}

async function load() {
  records = await fetchRecords();
  el("reportBtn").classList.remove("hidden");
  // routing via hash
  applyHash();
  window.addEventListener("hashchange", applyHash);
}

/* ---------------- filtering ---------------- */
function getPath(obj, path) { return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
const incl = (hay, needle) => String(hay == null ? "" : hay).toLowerCase().includes(String(needle).toLowerCase());

// Evaluate a record against a filter object (all keys ANDed). Supports:
// confMin/confMax, isEhrScreen, patientScope, systemName, patientName, vendor,
// costMin/costMax, and a generic { field, present|contains|equals }.
function recMatches(r, f) {
  if (!f) return true;
  const o = r.output || {}, sm = o.systemMetadata || {}, conf = sm.singlePatientConfidence;
  if (f.confMin != null && !(typeof conf === "number" && conf >= f.confMin)) return false;
  if (f.confMax != null && !(typeof conf === "number" && conf < f.confMax)) return false;
  if (f.isEhrScreen != null && sm.isEhrScreen !== f.isEhrScreen) return false;
  if (f.patientScope && sm.patientScope !== f.patientScope) return false;
  if (f.systemName && !incl(fval(sm.systemName), f.systemName)) return false;
  if (f.patientName && !incl(patientName(o), f.patientName)) return false;
  if (f.vendor && !incl(r.seed?.vendor || r.slug, f.vendor)) return false;
  const cost = r.price?.totalUSD;
  if (f.costMin != null && !(cost >= f.costMin)) return false;
  if (f.costMax != null && !(cost < f.costMax)) return false;
  if (f.field) {
    const v = fval(getPath(o, f.field));
    if (f.present === true && (v == null || v === "")) return false;
    if (f.present === false && !(v == null || v === "")) return false;
    if (f.contains != null && !incl(v, f.contains)) return false;
    if (f.equals != null && String(v == null ? "" : v).toLowerCase() !== String(f.equals).toLowerCase()) return false;
  }
  return true;
}
function visibleRecords() { return activeFilter ? records.filter((r) => recMatches(r, activeFilter)) : records; }

function filterDescription(f) {
  if (!f) return "";
  if (f.label) return f.label;
  const parts = [];
  if (f.confMin != null || f.confMax != null)
    parts.push(`confidence ${f.confMin != null ? "≥" + f.confMin : ""}${f.confMin != null && f.confMax != null ? " &" : ""}${f.confMax != null ? " <" + f.confMax : ""}`);
  if (f.isEhrScreen != null) parts.push(`isEhrScreen = ${f.isEhrScreen}`);
  if (f.patientScope) parts.push(`patientScope = ${f.patientScope}`);
  if (f.systemName) parts.push(`system name contains “${f.systemName}”`);
  if (f.patientName) parts.push(`patient name contains “${f.patientName}”`);
  if (f.vendor) parts.push(`vendor contains “${f.vendor}”`);
  if (f.costMin != null || f.costMax != null) parts.push(`cost ${f.costMin != null ? "≥$" + f.costMin : ""}${f.costMax != null ? " <$" + f.costMax : ""}`);
  if (f.field) {
    let s = f.field;
    if (f.present === true) s += " present"; if (f.present === false) s += " missing";
    if (f.contains != null) s += ` contains “${f.contains}”`; if (f.equals != null) s += ` = “${f.equals}”`;
    parts.push(s);
  }
  return parts.join(" · ") || "all records";
}
function setFilterHash(f) { location.hash = JSON.stringify(f); }
function renderFilterBanner() {
  const b = el("filterBanner");
  if (!activeFilter) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  el("filterDesc").textContent = filterDescription(activeFilter);
  el("filterCount").textContent = `· ${visibleRecords().length} of ${records.length} screenshots`;
}

/* ---------------- coverage report page ---------------- */
async function showReport() {
  listView.classList.add("hidden");
  detailView.classList.add("hidden");
  reportView.classList.remove("hidden");
  backBtn.classList.remove("hidden");
  topbarRight.textContent = "coverage report";
  const body = el("reportBody");
  body.innerHTML = '<div class="rpt-loading">Loading…</div>';
  let d;
  try { d = await fetchReport(); }
  catch { body.innerHTML = '<div class="rpt-loading">Failed to load report.</div>'; return; }

  const pct = d.vendors.attempted ? Math.round((100 * d.vendors.withScreenshots) / d.vendors.attempted) : 0;
  const FF = (f) => `data-filter='${JSON.stringify(f)}'`; // clickable → filtered list

  const fTop = d.funnel[0]?.vendors || 1;
  const stageFilter = [null, {}, { isEhrScreen: true, label: "EHR screens" },
    { isEhrScreen: true, patientScope: "single", label: "single-patient EHR screens" },
    { patientScope: "single", confMin: 0.8, label: "single-patient EHR, confidence ≥ 0.8" }];
  const funnel = d.funnel.map((f, i) => {
    const w = Math.max(3, Math.round((100 * f.vendors) / fTop));
    const ofTried = Math.round((100 * f.vendors) / fTop);
    const step = i > 0 ? Math.round((100 * f.vendors) / (d.funnel[i - 1].vendors || 1)) : 100;
    const flt = stageFilter[i];
    return `<div class="fn-row ${flt ? "clickable" : ""}" ${flt ? FF(flt) : ""}>
      <div class="fn-label">${esc(f.stage)}</div>
      <div class="fn-track"><div class="fn-bar s${i}" style="width:${w}%">${f.vendors}</div></div>
      <div class="fn-pct">${ofTried}%${i > 0 ? ` <span class="fn-step">(${step}% of prev)</span>` : ""}</div>
    </div>`;
  }).join("");

  const ch = d.confHistogram || [];
  const maxC = Math.max(1, ...ch.map((b) => b.count));
  const confBars = ch.map((b, i) => `
    <div class="bar-col clickable" ${FF({ confMin: i / 10, confMax: (i + 1) / 10, label: `confidence ${b.bin}` })} title="${b.count} screenshots, confidence ${b.bin} — click to filter">
      <div class="bar-val">${b.count}</div>
      <div class="bar conf" style="height:${Math.max(2, Math.round((100 * b.count) / maxC))}%"></div>
      <div class="bar-x">${b.bin}</div>
    </div>`).join("");

  const cz = d.costHistogram || [];
  const maxCz = Math.max(1, ...cz.map((b) => b.count));
  const costBars = cz.map((b, i) => `
    <div class="bar-col clickable" ${FF({ costMin: i * 0.002, costMax: (i + 1) * 0.002, label: `cost ${b.label}` })} title="${b.count} screenshots at ${b.label} — click to filter">
      <div class="bar-val">${b.count}</div>
      <div class="bar cost" style="height:${Math.max(2, Math.round((100 * b.count) / maxCz))}%"></div>
      <div class="bar-x">${b.label}</div>
    </div>`).join("");

  body.innerHTML = `
    <div class="rpt-head"><h2>Coverage report</h2><button class="btn" id="reportBack">&larr; List</button></div>
    <div class="rpt-tiles">
      <div class="rpt-tile"><div class="rt-num">${d.vendors.attempted}</div><div class="rt-lbl">developers (vendors) tried</div></div>
      <div class="rpt-tile good clickable" ${FF({})}><div class="rt-num">${d.vendors.withScreenshots}</div><div class="rt-lbl">developers with screenshots · ${pct}%</div></div>
      <div class="rpt-tile good clickable" ${FF({})}><div class="rt-num">${d.screenshots.total}</div><div class="rt-lbl">screenshots abstracted</div></div>
      <div class="rpt-tile"><div class="rt-num">${d.products.detectedOnScreen}</div><div class="rt-lbl">distinct products detected on-screen</div></div>
      <div class="rpt-tile" title="total $${d.cost.totalUSD} · median $${d.cost.medianPerScreenshot}"><div class="rt-num">$${(d.cost.avgPerScreenshot ?? 0).toFixed(4)}</div><div class="rt-lbl">avg cost / screenshot</div></div>
      <div class="rpt-tile"><div class="rt-num">${d.avgSinglePatientConfidence ?? "—"}</div><div class="rt-lbl">avg 1-patient conf</div></div>
    </div>
    <div class="rpt-sub">of ${d.vendors.total} CHPL developers in the worklist (${d.products.chplActiveListings} active product listings across them). We search <b>one product per developer</b>. Click any bar/stage below to open the filtered list.</div>
    <h3>Funnel — developers reaching each stage</h3>
    <div class="funnel">${funnel}</div>
    <h3>Confidence distribution — “EHR screen about a single patient” (per screenshot)</h3>
    <div class="histogram">${confBars}</div>
    <h3>Cost per screenshot · avg $${(d.cost.avgPerScreenshot ?? 0).toFixed(4)} · median $${d.cost.medianPerScreenshot} · total $${d.cost.totalUSD}</h3>
    <div class="histogram">${costBars}</div>`;

  el("reportBack").addEventListener("click", () => { location.hash = ""; });
  body.querySelectorAll("[data-filter]").forEach((n) => {
    n.addEventListener("click", () => { try { setFilterHash(JSON.parse(n.dataset.filter)); } catch {} });
  });
}

function applyHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h === "report") { activeFilter = null; renderFilterBanner(); showReport(); return; }
  const m = /^\/(\d+)$/.exec(h);
  if (m) {
    const i = Number(m[1]);
    if (i >= 0 && i < records.length) { renderFilterBanner(); showDetail(i); return; }
  }
  if (h.startsWith("{")) { try { activeFilter = JSON.parse(h); } catch { activeFilter = null; } renderFilterBanner(); showList(); return; }
  activeFilter = null; renderFilterBanner(); showList();
}

/* ---------------- LIST ---------------- */
function renderList() {
  const vis = visibleRecords();
  el("listEmpty").classList.toggle("hidden", vis.length > 0);
  gallery.innerHTML = "";
  for (const r of vis) {
    const o = r.output || {};
    const sm = o.systemMetadata || {};
    const patient = patientName(o) || "—";
    const tok = r.usage ? r.usage.totalTokens : null;
    const cost = r.price ? r.price.totalUSD : null;
    const conf = sm.singlePatientConfidence;
    const seed = r.seed || {};

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <img class="card-thumb" loading="lazy" alt="">
      <div class="card-body">
        <div class="card-title">${esc(seed.vendor || vendorOf(r.file))}</div>
        <div class="card-sub">${esc((seed.products || []).join(", "))}</div>
        <div class="card-fn">${esc(fval(sm.activeFunction) || "(no activeFunction)")}</div>
        <div class="card-patient">${esc(patient)}</div>
        <div class="card-badges">
          <span class="badge conf ${confClass(conf)}" title="confidence: EHR screen about a single patient">${fmtConf(conf)} 1-pt</span>
          <span class="badge">${esc(sm.patientScope || "?")}</span>
          <span class="badge cost">${fmtUSD(cost)}</span>
        </div>
      </div>`;
    card.addEventListener("click", () => { location.hash = `#/${r.index}`; });
    setImg(card.querySelector(".card-thumb"), r);
    gallery.appendChild(card);
  }
}

function showList() {
  current = -1;
  renderList();
  listView.classList.remove("hidden");
  detailView.classList.add("hidden");
  reportView.classList.add("hidden");
  backBtn.classList.add("hidden");
  const vis = visibleRecords().length;
  topbarRight.textContent = activeFilter ? `${vis} of ${records.length}` : `${records.length} record${records.length === 1 ? "" : "s"}`;
}

/* ---------------- v1/v2 shape helpers ---------------- */
// v2 fields are { value, box }; v1 fields are bare strings. fval() handles both.
function fval(x) { return x && typeof x === "object" && "value" in x ? x.value : x; }
function patientName(o) { return fval((o.patient || {}).fullName) ?? null; }

// v2 field map: [dotted-path, label, fieldObject]. Used to build the box list
// (boxes now live inline on each field) and to label them.
function v2Fields(o) {
  const sm = o.systemMetadata || {}, p = o.patient || {}, ec = o.encounterContext || {}, ins = p.insurance || {};
  return [
    ["systemMetadata.systemName", "System Name", sm.systemName],
    ["systemMetadata.clinicalSpecialty", "Clinical Specialty", sm.clinicalSpecialty],
    ["systemMetadata.activeFunction", "Active Function", sm.activeFunction],
    ["systemMetadata.uiSection", "UI Section", sm.uiSection],
    ["loggedInUser", "Logged-in User", o.loggedInUser],
    ["patient.fullName", "Patient Name", p.fullName],
    ["patient.firstName", "First Name", p.firstName],
    ["patient.lastName", "Last Name", p.lastName],
    ["patient.dateOfBirth", "Date of Birth", p.dateOfBirth],
    ["patient.age", "Age", p.age],
    ["patient.sex", "Sex", p.sex],
    ["patient.phone", "Phone", p.phone],
    ["patient.email", "Email", p.email],
    ["patient.address", "Address", p.address],
    ["patient.insurance.primaryPayer", "Insurance (primary)", ins.primaryPayer],
    ["patient.insurance.secondaryPayer", "Insurance (secondary)", ins.secondaryPayer],
    ["patient.insurance.memberId", "Member ID", ins.memberId],
    ["patient.insurance.groupNumber", "Group #", ins.groupNumber],
    ["encounterContext.encounterDate", "Encounter Date", ec.encounterDate],
    ["encounterContext.encounterType", "Encounter Type", ec.encounterType],
    ["encounterContext.location", "Location", ec.location],
    ["encounterContext.visitId", "Visit ID", ec.visitId],
  ];
}

// Annotation list (boxes): inline field boxes + array-entry boxes
// (patient.identifiers[], providers[]).
function buildAnnotations(o) {
  const out = [];
  for (const [field, label, f] of v2Fields(o)) {
    if (f && typeof f === "object" && (f.box || f.boxPx)) {
      out.push({ field, label, text: f.value, box: f.box, boxPx: f.boxPx });
    }
  }
  (o.patient?.identifiers || []).forEach((id, i) => {
    if (id && (id.box || id.boxPx)) out.push({ field: `patient.identifiers.${i}`, label: id.label || id.type || "ID", text: id.value, box: id.box, boxPx: id.boxPx });
  });
  (o.providers || []).forEach((pr, i) => {
    if (pr && (pr.box || pr.boxPx)) out.push({ field: `providers.${i}`, label: `provider${pr.role ? " (" + pr.role + ")" : ""}`, text: pr.name, box: pr.box, boxPx: pr.boxPx });
  });
  return out;
}

/* ---------------- DETAIL ---------------- */
function kvRow(label, value, field) {
  const isNull = value == null || value === "";
  const v = isNull ? "null" : esc(value);
  const f = field ? ` data-field="${esc(field)}"` : "";
  return `<div class="k"${f}>${esc(label)}</div><div class="v ${isNull ? "null" : ""}"${f}>${v}</div>`;
}

function showDetail(i) {
  current = i;
  const r = records[i];
  const o = r.output || {};
  const sm = o.systemMetadata || {};
  const p = o.patient || {};
  const ec = o.encounterContext || {};
  const ins = p.insurance || {};
  const ids = Array.isArray(p.identifiers) ? p.identifiers : [];
  const provs = Array.isArray(o.providers) ? o.providers : [];
  const seed = r.seed || {};
  const annotations = buildAnnotations(o);
  const additional = Array.isArray(o.additionalFields) ? o.additionalFields : [];

  listView.classList.add("hidden");
  detailView.classList.remove("hidden");
  reportView.classList.add("hidden");
  backBtn.classList.remove("hidden");
  topbarRight.textContent = vendorOf(r.file);

  // position within the (possibly filtered) set, for nav
  let pos = i, len = records.length;
  if (activeFilter) {
    const order = visibleRecords().map((x) => x.index);
    const p = order.indexOf(i);
    if (p >= 0) { pos = p; len = order.length; }
  }

  // metrics
  const usage = r.usage || {};
  const price = r.price || {};

  // Nav + metrics live UNDER the image (in the otherwise-wasted vertical space
  // beside a short/wide screenshot); the right pane is pure data.
  el("imageFooter").innerHTML = `
    <div class="detail-nav">
      <button class="btn" id="prevBtn" title="Previous (←)">&larr; Prev</button>
      <button class="btn" id="nextBtn" title="Next (→)">Next &rarr;</button>
      <span class="pos">${pos + 1} / ${len}</span>
      <label class="toggle" title="Show all boxes, or only when hovering a box/field">
        <input type="checkbox" id="showAllBoxes"> show all boxes
      </label>
    </div>
    <div class="metrics">
      <div class="metric ${confClass(sm.singlePatientConfidence)}"><div class="m-label">1-patient EHR conf</div><div class="m-val">${fmtConf(sm.singlePatientConfidence)}</div></div>
      <div class="metric"><div class="m-label">In tok</div><div class="m-val">${fmtTok(usage.inputTokens)}</div></div>
      <div class="metric"><div class="m-label">Out tok</div><div class="m-val">${fmtTok(usage.outputTokens)}</div></div>
      <div class="metric cost"><div class="m-label">Cost</div><div class="m-val">${fmtUSD(price.totalUSD)}</div></div>
    </div>`;

  jsonPane.innerHTML = `
    <div class="section">
      <h3>CHPL Source (seed)</h3>
      <div class="kv">
        <div class="k">vendor</div><div class="v">${esc(seed.vendor || "—")}</div>
        <div class="k">product(s)</div><div class="v">${esc((seed.products || []).join(", ") || "—")}</div>
        <div class="k">website</div><div class="v">${webLink(seed.website)}</div>
        <div class="k">slug</div><div class="v">${esc(r.slug || "—")}</div>
        <div class="k">listings</div><div class="v">${seed.listingCount == null ? "—" : seed.listingCount}</div>
      </div>
    </div>

    <div class="section">
      <h3>System / Session (detected)</h3>
      <div class="kv">
        ${kvRow("isEhrScreen", sm.isEhrScreen == null ? null : String(sm.isEhrScreen), "systemMetadata.isEhrScreen")}
        ${kvRow("patientScope", sm.patientScope, "systemMetadata.patientScope")}
        ${kvRow("singlePatientConfidence", fmtConf(sm.singlePatientConfidence), "systemMetadata.singlePatientConfidence")}
        ${kvRow("systemName", fval(sm.systemName), "systemMetadata.systemName")}
        ${kvRow("clinicalSpecialty", fval(sm.clinicalSpecialty), "systemMetadata.clinicalSpecialty")}
        ${kvRow("activeFunction", fval(sm.activeFunction), "systemMetadata.activeFunction")}
        ${kvRow("uiSection", fval(sm.uiSection), "systemMetadata.uiSection")}
        ${kvRow("loggedInUser (operator)", fval(o.loggedInUser), "loggedInUser")}
      </div>
    </div>

    <div class="section">
      <h3>Patient — Identifiers</h3>
      <div class="kv">
        ${p.primaryId && (p.primaryId.value != null) ? kvRow("primaryId", `${p.primaryId.value}${p.primaryId.type ? " (" + p.primaryId.type + ")" : ""}`) : ""}
      </div>
      <div class="annot-list">
        ${ids.map((id, i) => `
          <div class="annot" data-field="patient.identifiers.${i}">
            <div class="a-top"><span class="a-label">${esc(id.value == null ? "" : id.value)}</span><span class="a-cat">${esc(id.type || "")}${id.masked ? " · masked" : ""}</span></div>
            <div class="a-text">${esc(id.label || "")}</div>
          </div>`).join("")}
        ${ids.length === 0 && (!p.primaryId || p.primaryId.value == null) ? '<div class="kv"><div class="v null">none</div></div>' : ''}
      </div>
    </div>

    <div class="section">
      <h3>Patient — Demographics</h3>
      <div class="kv">
        ${kvRow("fullName", patientName(o), "patient.fullName")}
        ${kvRow("firstName", fval(p.firstName), "patient.firstName")}
        ${kvRow("lastName", fval(p.lastName), "patient.lastName")}
        ${kvRow("dateOfBirth", fval(p.dateOfBirth), "patient.dateOfBirth")}
        ${kvRow("age", fval(p.age), "patient.age")}
        ${kvRow("sex", fval(p.sex), "patient.sex")}
        ${kvRow("phone", fval(p.phone), "patient.phone")}
        ${kvRow("email", fval(p.email), "patient.email")}
        ${kvRow("address", fval(p.address), "patient.address")}
      </div>
    </div>

    <div class="section">
      <h3>Insurance</h3>
      <div class="kv">
        ${kvRow("primaryPayer", fval(ins.primaryPayer), "patient.insurance.primaryPayer")}
        ${kvRow("secondaryPayer", fval(ins.secondaryPayer), "patient.insurance.secondaryPayer")}
        ${kvRow("memberId", fval(ins.memberId), "patient.insurance.memberId")}
        ${kvRow("groupNumber", fval(ins.groupNumber), "patient.insurance.groupNumber")}
      </div>
    </div>

    <div class="section">
      <h3>Providers (of record)</h3>
      <div class="annot-list">
        ${provs.length === 0 ? '<div class="kv"><div class="v null">none</div></div>' : provs.map((pr, i) => `
          <div class="annot" data-field="providers.${i}">
            <div class="a-top"><span class="a-label">${esc(pr.name || "")}</span><span class="a-cat">${esc(pr.role || "")}${pr.credential ? " · " + esc(pr.credential) : ""}</span></div>
          </div>`).join("")}
      </div>
    </div>

    <div class="section">
      <h3>Encounter</h3>
      <div class="kv">
        ${kvRow("encounterDate", fval(ec.encounterDate), "encounterContext.encounterDate")}
        ${kvRow("encounterType", fval(ec.encounterType), "encounterContext.encounterType")}
        ${kvRow("location", fval(ec.location), "encounterContext.location")}
        ${kvRow("visitId", fval(ec.visitId), "encounterContext.visitId")}
      </div>
    </div>

    <div class="section">
      <h3>Additional Fields — not in base schema (${additional.length})</h3>
      <div class="annot-list" id="addlList">
        ${additional.length === 0 ? '<div class="kv"><div class="v null">none</div></div>' : ""}
        ${additional.map((a, idx) => `
          <div class="annot addl" data-addl="${idx}">
            <div class="a-top">
              <span class="a-label">${esc(a.label || "")}</span>
              <span class="a-cat">${esc(a.category || "")}</span>
            </div>
            <div class="a-text">${esc(a.value == null ? "" : a.value)}</div>
          </div>`).join("")}
      </div>
    </div>
  `;

  el("prevBtn").disabled = pos <= 0;
  el("nextBtn").disabled = pos >= len - 1;
  el("prevBtn").addEventListener("click", () => navigate(-1));
  el("nextBtn").addEventListener("click", () => navigate(1));

  // box-visibility toggle (show-all vs hover-only)
  const showAll = el("showAllBoxes");
  showAll.checked = boxesShowAll;
  overlay.classList.toggle("hover-only", !boxesShowAll);
  showAll.addEventListener("change", () => {
    boxesShowAll = showAll.checked;
    localStorage.setItem("boxesShowAll", boxesShowAll ? "1" : "0");
    overlay.classList.toggle("hover-only", !boxesShowAll);
  });

  // wire JSON field hover -> its annotation box (orange highlight)
  const annByField = {};
  annotations.forEach((a, idx) => {
    if (a.field && !(a.field in annByField)) annByField[a.field] = idx;
  });
  jsonPane.querySelectorAll("[data-field]").forEach((node) => {
    const f = node.dataset.field;
    if (!(f in annByField)) return; // no box for this field
    const idx = annByField[f];
    node.classList.add("linked");
    node.addEventListener("mouseenter", () => setActive("annot", idx, true));
    node.addEventListener("mouseleave", () => setActive("annot", idx, false));
    node.addEventListener("click", () => {
      const box = overlay.querySelector(`.box[data-annot="${idx}"]`);
      if (box) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });

  // wire Additional Fields cards <-> their boxes
  jsonPane.querySelectorAll(".addl").forEach((node) => {
    const idx = Number(node.dataset.addl);
    node.addEventListener("mouseenter", () => setActive("addl", idx, true));
    node.addEventListener("mouseleave", () => setActive("addl", idx, false));
    node.addEventListener("click", () => {
      const box = overlay.querySelector(`.box[data-addl="${idx}"]`);
      if (box) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });

  // load image + draw boxes
  overlay.innerHTML = "";
  detailImg.onload = () => drawBoxes(r);
  setImg(detailImg, r);
  if (detailImg.complete && detailImg.naturalWidth) drawBoxes(r);
}

function boxRectPx(a, natW, natH) {
  if (a.boxPx) return [a.boxPx.x, a.boxPx.y, a.boxPx.width, a.boxPx.height];
  if (a.box) return [
    (a.box.xmin / 1000) * natW,
    (a.box.ymin / 1000) * natH,
    ((a.box.xmax - a.box.xmin) / 1000) * natW,
    ((a.box.ymax - a.box.ymin) / 1000) * natH,
  ];
  return null;
}

const SVGNS = "http://www.w3.org/2000/svg";

function drawBoxes(r) {
  overlay.innerHTML = "";
  const o = r.output || {};
  const annotations = buildAnnotations(o);
  const additional = Array.isArray(o.additionalFields) ? o.additionalFields : [];
  const natW = (r.imageSize && r.imageSize.width) || detailImg.naturalWidth;
  const natH = (r.imageSize && r.imageSize.height) || detailImg.naturalHeight;
  const rendW = detailImg.clientWidth;
  const rendH = detailImg.clientHeight;
  if (!natW || !natH || !rendW) return;
  const sx = rendW / natW;
  const sy = rendH / natH;

  // leader-line layer (under boxes/labels), then boxes, then a label layer on top
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "leaders");
  svg.setAttribute("width", rendW);
  svg.setAttribute("height", rendH);
  overlay.appendChild(svg);

  const labels = []; // {el, kind, idx, w, h, x, y, homeX, homeY, ax, ay, line, dot}
  const boxRects = []; // fixed obstacles {x,y,w,h}

  const draw = (a, idx, kind) => {
    const rect = boxRectPx(a, natW, natH);
    if (!rect) return;
    const [x, y, w, h] = rect;
    const bx = x * sx, by = y * sy, bw = w * sx, bh = h * sy;
    boxRects.push({ x: bx, y: by, w: bw, h: bh });

    const div = document.createElement("div");
    div.className = kind === "addl" ? "box box-addl" : "box";
    div.dataset[kind === "addl" ? "addl" : "annot"] = String(idx);
    div.style.left = bx + "px";
    div.style.top = by + "px";
    div.style.width = bw + "px";
    div.style.height = bh + "px";
    div.addEventListener("mouseenter", () => setActive(kind, idx, true));
    div.addEventListener("mouseleave", () => setActive(kind, idx, false));
    overlay.appendChild(div);

    // anchor = top-center of the box; leader dot sits here
    const ax = bx + bw / 2, ay = by;

    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("class", "leader" + (kind === "addl" ? " addl" : ""));
    line.dataset[kind === "addl" ? "addl" : "annot"] = String(idx);
    svg.appendChild(line);
    const dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("r", "2.5");
    dot.setAttribute("class", "leader-dot" + (kind === "addl" ? " addl" : ""));
    dot.dataset[kind === "addl" ? "addl" : "annot"] = String(idx);
    dot.setAttribute("cx", ax); dot.setAttribute("cy", ay);
    svg.appendChild(dot);

    const lab = document.createElement("div");
    lab.className = "flabel" + (kind === "addl" ? " addl" : "");
    lab.dataset[kind === "addl" ? "addl" : "annot"] = String(idx);
    lab.textContent = a.label || a.field || a.category || "";
    lab.addEventListener("mouseenter", () => setActive(kind, idx, true));
    lab.addEventListener("mouseleave", () => setActive(kind, idx, false));
    overlay.appendChild(lab);

    const lw = lab.offsetWidth, lh = lab.offsetHeight;
    const homeX = Math.max(0, Math.min(ax - lw / 2, rendW - lw));
    // prefer above the box; if there's no room above, place below it
    let homeY = by - lh - 6;
    if (homeY < 0) homeY = by + bh + 6;
    homeY = Math.max(0, Math.min(homeY, rendH - lh));
    labels.push({ el: lab, kind, idx, w: lw, h: lh, x: homeX, y: homeY, homeX, homeY, ax, ay, line, dot, box: { x: bx, y: by, w: bw, h: bh } });
  };

  annotations.forEach((a, idx) => draw(a, idx, "annot"));
  additional.forEach((a, idx) => draw(a, idx, "addl"));

  layoutLabels(labels, boxRects, rendW, rendH);

  // commit positions + leader endpoints (anchor to nearest point on the box)
  for (const L of labels) {
    L.el.style.left = L.x + "px";
    L.el.style.top = L.y + "px";
    const lcx = L.x + L.w / 2, lcy = L.y + L.h / 2;
    const B = L.box;
    const axp = Math.max(B.x, Math.min(lcx, B.x + B.w));
    const ayp = Math.max(B.y, Math.min(lcy, B.y + B.h));
    // start from label center (segment inside the label is hidden beneath it)
    L.line.setAttribute("x1", lcx); L.line.setAttribute("y1", lcy);
    L.line.setAttribute("x2", axp); L.line.setAttribute("y2", ayp);
    L.dot.setAttribute("cx", axp); L.dot.setAttribute("cy", ayp);
  }
}

const GAP = 2; // minimum gap so things "kiss" but never overlap

function overlapAABB(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return [ox, oy];
}

/**
 * Place labels so they don't overlap each other OR the (fixed) boxes.
 * Phase 1: soft force relaxation, anchored above each box, repelled by labels
 *          and boxes. Phase 2: hard minimum-translation resolve to guarantee
 *          no residual overlap (touching/kissing is allowed).
 */
function layoutLabels(labels, boxes, W, H, iterations = 160) {
  const clamp = (L) => {
    L.x = Math.max(0, Math.min(L.x, W - L.w));
    L.y = Math.max(0, Math.min(L.y, H - L.h));
  };

  // Phase 1 — soft forces
  for (let it = 0; it < iterations; it++) {
    const vx = new Array(labels.length).fill(0);
    const vy = new Array(labels.length).fill(0);
    for (let i = 0; i < labels.length; i++) {
      vx[i] += (labels[i].homeX - labels[i].x) * 0.05;
      vy[i] += (labels[i].homeY - labels[i].y) * 0.05;
    }
    // label vs label (both move)
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const A = labels[i], B = labels[j];
        const [ox, oy] = overlapAABB(A, B);
        if (ox > -GAP && oy > -GAP) {
          let dy = (A.y + A.h / 2) - (B.y + B.h / 2); if (Math.abs(dy) < 0.5) dy = (i % 2 ? 1 : -1);
          const s = dy > 0 ? 1 : -1, push = (oy + GAP) / 2;
          vy[i] += s * push * 0.6; vy[j] -= s * push * 0.6;
          let dx = (A.x + A.w / 2) - (B.x + B.w / 2);
          const sx2 = dx >= 0 ? 1 : -1;
          vx[i] += sx2 * (ox + GAP) * 0.06; vx[j] -= sx2 * (ox + GAP) * 0.06;
        }
      }
    }
    // label vs box (only label moves; push out along least-penetration axis)
    for (let i = 0; i < labels.length; i++) {
      for (const B of boxes) {
        const [ox, oy] = overlapAABB(labels[i], B);
        if (ox > 0 && oy > 0) {
          if (ox < oy) {
            const s = (labels[i].x + labels[i].w / 2) >= (B.x + B.w / 2) ? 1 : -1;
            vx[i] += s * (ox + GAP) * 0.5;
          } else {
            const s = (labels[i].y + labels[i].h / 2) >= (B.y + B.h / 2) ? 1 : -1;
            vy[i] += s * (oy + GAP) * 0.5;
          }
        }
      }
    }
    for (let i = 0; i < labels.length; i++) { labels[i].x += vx[i]; labels[i].y += vy[i]; clamp(labels[i]); }
  }

  // Phase 2 — hard resolve. Vertical-biased: labels move OFF boxes and apart
  // from each other along Y (that's where the whitespace is on dense screens).
  // Boxes never move. Touching (kissing) is allowed; overlap is not.
  for (let pass = 0; pass < 90; pass++) {
    let moved = false;
    // push each label fully clear of every box, to the nearer in-bounds side
    for (const L of labels) {
      for (const B of boxes) {
        const [ox, oy] = overlapAABB(L, B);
        if (ox > 0 && oy > 0) {
          moved = true;
          const up = B.y - L.h - GAP;      // label fully above the box
          const down = B.y + B.h + GAP;    // label fully below the box
          const canUp = up >= 0, canDown = down + L.h <= H;
          if (canUp && (!canDown || (L.y - up) <= (down - L.y))) L.y = up;
          else if (canDown) L.y = down;
          else L.y += ((L.y + L.h / 2) >= (B.y + B.h / 2) ? 1 : -1) * (oy + GAP);
          clamp(L);
        }
      }
    }
    // separate labels from each other, vertically
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const A = labels[i], B = labels[j];
        const [ox, oy] = overlapAABB(A, B);
        if (ox > 0 && oy > 0) {
          moved = true;
          const half = (oy + GAP) / 2, s = (A.y + A.h / 2) >= (B.y + B.h / 2) ? 1 : -1;
          A.y += s * half; B.y -= s * half;
          clamp(A); clamp(B);
        }
      }
    }
    if (!moved) break;
  }
}

function setActive(kind, idx, on) {
  const sel = kind === "addl" ? "addl" : "annot";
  const cardSel = kind === "addl" ? "addl" : "annot";
  overlay.querySelectorAll(`.box[data-${sel}="${idx}"], .flabel[data-${sel}="${idx}"], .leader[data-${sel}="${idx}"], .leader-dot[data-${sel}="${idx}"]`)
    .forEach((n) => n.classList.toggle("active", on));
  const card = jsonPane.querySelector(`.${cardSel}[data-${sel}="${idx}"]`);
  if (card) card.classList.toggle("active", on);
}

function navigate(delta) {
  if (activeFilter) {
    const order = visibleRecords().map((x) => x.index);
    const pos = order.indexOf(current);
    if (pos >= 0) {
      const np = pos + delta;
      if (np < 0 || np >= order.length) return;
      location.hash = `#/${order[np]}`;
      return;
    }
  }
  const next = current + delta;
  if (next < 0 || next >= records.length) return;
  location.hash = `#/${next}`;
}

/* ---------------- events ---------------- */
// Back: report → list; filtered detail → filtered list; else list.
backBtn.addEventListener("click", () => {
  if (!reportView.classList.contains("hidden")) { location.hash = ""; return; }
  if (activeFilter && current >= 0) { setFilterHash(activeFilter); return; }
  location.hash = "";
});

el("reportBtn").addEventListener("click", () => { location.hash = "report"; });
el("filterClear").addEventListener("click", () => { location.hash = ""; });

window.addEventListener("keydown", (e) => {
  if (!reportView.classList.contains("hidden")) {
    if (e.key === "Escape") location.hash = "";
    return;
  }
  if (current < 0) return; // only in detail
  if (e.key === "ArrowLeft") { navigate(-1); }
  else if (e.key === "ArrowRight") { navigate(1); }
  else if (e.key === "Escape") { backBtn.click(); }
});

let resizeTimer;
window.addEventListener("resize", () => {
  if (current < 0) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawBoxes(records[current]);
  }, 60);
});

load();
