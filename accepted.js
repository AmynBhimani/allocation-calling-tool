let DATA = { volunteers: [] };
const filters = { region: "", jk: "", area: "", group: "", q: "", notInBi: false };
const EL = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function banner(msg, isErr) { const b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }

async function boot() {
  try { const me = await (await fetch("/.auth/me")).json(); const cp = me && me.clientPrincipal; if (cp) EL("whoami").innerHTML = `<b>${esc(cp.userDetails)}</b>`; } catch (e) {}
  ["BC", "Prairies", "Edmonton"].forEach(r => { const o = document.createElement("option"); o.value = r; o.textContent = r; EL("regionSel").appendChild(o); });
  EL("regionSel").addEventListener("change", e => { filters.region = e.target.value; render(); });
  EL("jkSel").addEventListener("change", e => { filters.jk = e.target.value; render(); });
  EL("areaSel").addEventListener("change", e => { filters.area = e.target.value; render(); });
  EL("groupSel").addEventListener("change", e => { filters.group = e.target.value; render(); });
  EL("rows").addEventListener("click", (e) => {
    if (e.target.closest("input,button,a,label")) return;
    const tr = e.target.closest("tr[data-id]"); if (!tr) return;
    selectVolunteer(tr.getAttribute("data-id"), tr.getAttribute("data-region"), tr);
  });
  EL("q").addEventListener("input", e => { filters.q = e.target.value; render(); });
  EL("notInBi").addEventListener("change", e => { filters.notInBi = e.target.checked; render(); });
  EL("exportBtn").addEventListener("click", exportCsv);
  await load();
}

async function load() {
  EL("count").textContent = "Loading…";
  try {
    const r = await fetch("/api/accepted");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status));
    DATA = await r.json();
    EL("banner").hidden = true;
    buildDropdowns();
    render();
  } catch (e) { banner("Could not load: " + e.message, true); EL("count").textContent = "Load failed."; }
}

function buildDropdowns() {
  const regions = [...new Set(DATA.volunteers.map(v => v.region).filter(Boolean))].sort();
  // only show region selector options the viewer actually has data for
  EL("regionSel").innerHTML = '<option value="">All regions</option>' + regions.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
  const jks = [...new Set(DATA.volunteers.map(v => v.jk).filter(Boolean))].sort();
  const areas = [...new Set(DATA.volunteers.map(v => v.area).filter(Boolean))].sort();
  EL("jkSel").innerHTML = '<option value="">All Jamatkhanas</option>' + jks.map(j => `<option value="${esc(j)}">${esc(j)}</option>`).join("");
  EL("areaSel").innerHTML = '<option value="">All areas</option>' + areas.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  EL("regionSel").value = filters.region; EL("jkSel").value = filters.jk; EL("areaSel").value = filters.area;
}

function renderTiles(list) {
  const total = list.length;
  const inBi = list.filter(v => v.entered).length;
  const filtered = total !== DATA.volunteers.length;
  EL("kpis").innerHTML = [
    ["stable", total, filtered ? "Accepted (filtered)" : "Accepted Volunteers"],
    ["callable", inBi, "Entered in Better Impact"],
    ["recon", total - inBi, "Awaiting BI Entry"],
  ].map(([cls, n, l]) => `<div class="kpi ${cls}"><div class="n">${(n || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join("");
}

function matchesGroup(v, g) {
  if (g === "iff") return !!v.iff;
  if (g === "diverse") return !!v.diverse;
  if (g === "seniors") return v.age != null && v.age > 65;
  if (g === "young") return v.age != null && v.age >= 5 && v.age <= 13;
  return true;
}

// ---- Detail panel: fetch one volunteer's contact, duties of interest, and call history on click ----
let DETAIL_ID = null;
async function selectVolunteer(id, region, trEl) {
  DETAIL_ID = String(id);
  document.querySelectorAll("#rows tr.active").forEach(r => r.classList.remove("active"));
  if (trEl) trEl.classList.add("active");
  const panel = EL("detailPanel");
  panel.className = "detailcard";
  panel.innerHTML = `<div class="dmuted">Loading…</div>`;
  try {
    const r = await fetch(`/api/volunteer?id=${encodeURIComponent(id)}&region=${encodeURIComponent(region)}`);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Error ${r.status}`); }
    const d = await r.json();
    if (DETAIL_ID !== String(id)) return;   // a newer click already won — drop this stale response
    renderDetail(d);
  } catch (err) {
    if (DETAIL_ID !== String(id)) return;
    panel.className = "detailcard";
    panel.innerHTML = `<div class="dmuted">Couldn't load details: ${esc(err.message)}</div>`;
  }
}
function renderDetail(d) {
  const tel = (n) => `tel:${String(n).replace(/[^\d+]/g, "")}`;
  const contact = `<div class="contact">
    <label>Cell</label><div class="phone">${d.cell ? `<a href="${tel(d.cell)}">${esc(d.cell)}</a>` : "—"}</div>
    ${d.home ? `<label>Home</label><div class="phone"><a href="${tel(d.home)}">${esc(d.home)}</a></div>` : ""}
    ${d.work ? `<label>Work</label><div class="phone"><a href="${tel(d.work)}">${esc(d.work)}</a></div>` : ""}
    <label>Email</label><div>${d.email ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : "—"}</div>
    ${d.jk ? `<label>Jamatkhana</label><div>${esc(d.jk)}</div>` : ""}
    ${d.age != null ? `<label>Age</label><div>${d.age}</div>` : ""}
  </div>`;
  const dutiesHtml = `<div class="dsec"><h4>Duties of interest</h4>${
    (d.duties && d.duties.length)
      ? `<div class="chiprow">${d.duties.map(x => `<span class="chip">${esc(x)}</span>`).join("")}</div>`
      : `<div class="dmuted">None captured yet — duties are noted when a caller reaches them.</div>`}</div>`;
  const prefs = d.happyAnywhere ? ["Happy anywhere"] : (d.prefAreas || []);
  const prefHtml = prefs.length
    ? `<div class="dsec"><h4>Preferred areas</h4><div class="chiprow">${prefs.map(x => `<span class="chip">${esc(x)}</span>`).join("")}</div></div>`
    : "";
  const log = d.log || [];
  const logHtml = `<div class="dsec log"><h4>Call history</h4>${
    log.length
      ? log.map(e => `<div class="e"><span class="t">${new Date(e.ts).toLocaleString()}</span> — ${esc(e.outcome || "—")}${e.note ? ": " + esc(e.note) : ""}</div>`).join("")
      : `<div class="dmuted">No calls logged yet.</div>`}</div>`;
  const panel = EL("detailPanel");
  panel.className = "detailcard";
  panel.innerHTML = `<h2>${esc(d.name)}</h2><div class="sub2">${esc(d.region)}${d.area ? " · " + esc(d.area) : ""}</div>${contact}${dutiesHtml}${prefHtml}${logHtml}`;
}
function shown() {
  const q = filters.q.trim().toLowerCase();
  return DATA.volunteers.filter(v =>
    (!filters.region || v.region === filters.region) &&
    (!filters.jk || v.jk === filters.jk) &&
    (!filters.area || v.area === filters.area) &&
    (!filters.group || matchesGroup(v, filters.group)) &&
    (!filters.notInBi || !v.entered) &&
    (!q || v.name.toLowerCase().includes(q)));
}

function fmtDate(s) { if (!s) return "—"; const d = new Date(s); return isNaN(d) ? "—" : d.toLocaleDateString(); }

function render() {
  const list = shown();
  renderTiles(list);
  const rows = EL("rows");
  if (!list.length) { rows.innerHTML = `<tr><td colspan="7"><div class="empty">No accepted volunteers match these filters.</div></td></tr>`; EL("count").textContent = ""; return; }
  rows.innerHTML = list.slice(0, 2000).map(v => `<tr data-id="${esc(v.id)}" data-region="${esc(v.region)}">
    <td>${esc(v.name)}</td><td>${esc(v.region)}</td><td>${esc(v.jk) || "—"}</td>
    <td>${esc(v.area) || "—"}</td><td class="n">${v.age == null ? "—" : v.age}</td>
    <td>${v.entered ? '<span class="pill ok">In BI</span>' : '<span class="pill no">Not yet</span>'}</td>
    <td>${fmtDate(v.acceptedAt)}</td>
  </tr>`).join("");
  const more = list.length > 2000 ? ` (showing first 2000 — narrow with filters or Export CSV for all)` : "";
  EL("count").textContent = `${list.length.toLocaleString()} of ${DATA.volunteers.length.toLocaleString()} accepted${more}`;
}

function exportCsv() {
  const list = shown();
  const cols = ["Name", "Region", "Jamatkhana", "Area", "Age", "In Better Impact", "Accepted"];
  const esc2 = s => { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(",")];
  for (const v of list) lines.push([v.name, v.region, v.jk, v.area || "", v.age == null ? "" : v.age, v.entered ? "Yes" : "No", fmtDate(v.acceptedAt)].map(esc2).join(","));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = `accepted-volunteers-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

boot();
