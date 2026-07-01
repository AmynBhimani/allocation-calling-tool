let DATA = { volunteers: [], tiles: null };
const filters = { region: "", jk: "", area: "", q: "", acceptedOnly: false, needsDecisionOnly: false };
const EL = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function banner(msg, isErr) { const b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }

async function boot() {
  try { const me = await (await fetch("/.auth/me")).json(); const cp = me && me.clientPrincipal; if (cp) EL("whoami").innerHTML = `<b>${esc(cp.userDetails)}</b>`; } catch (e) {}
  ["BC", "Prairies", "Edmonton"].forEach(r => { const o = document.createElement("option"); o.value = r; o.textContent = r; EL("regionSel").appendChild(o); });
  EL("regionSel").addEventListener("change", e => { filters.region = e.target.value; load(); });
  EL("jkSel").addEventListener("change", e => { filters.jk = e.target.value; render(); });
  EL("areaSel").addEventListener("change", e => { filters.area = e.target.value; render(); });
  EL("q").addEventListener("input", e => { filters.q = e.target.value; render(); });
  EL("acceptedOnly").addEventListener("change", e => { filters.acceptedOnly = e.target.checked; render(); });
  EL("needsDecisionOnly").addEventListener("change", e => { filters.needsDecisionOnly = e.target.checked; render(); });
  EL("exportBtn").addEventListener("click", exportCsv);
  await load();
}

async function load() {
  EL("count").textContent = "Loading…";
  try {
    const r = await fetch("/api/allvolunteers" + (filters.region ? ("?region=" + encodeURIComponent(filters.region)) : ""));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status));
    DATA = await r.json();
    EL("banner").hidden = true;
    buildDropdowns();
    renderTiles();
    render();
  } catch (e) { banner("Could not load: " + e.message, true); EL("count").textContent = "Load failed."; }
}

function buildDropdowns() {
  const jks = [...new Set(DATA.volunteers.map(v => v.jk).filter(Boolean))].sort();
  const areas = [...new Set(DATA.volunteers.map(v => v.area).filter(Boolean))].sort();
  EL("jkSel").innerHTML = '<option value="">All Jamatkhanas</option>' + jks.map(j => `<option value="${esc(j)}">${esc(j)}</option>`).join("");
  EL("areaSel").innerHTML = '<option value="">All areas</option>' + areas.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  EL("jkSel").value = filters.jk; EL("areaSel").value = filters.area;
}

function renderTiles() {
  const t = DATA.tiles || {};
  EL("kpis").innerHTML = [
    ["", t.total, "Total Volunteers"],
    ["callable", t.allocated, "Allocated to an Area"],
    ["stable", t.accepted, "Accepted Assignment"],
    ["recon", t.callPending, "Call Pending"],
    ["un", t.toAssign, "To Be Assigned to a Caller"],
  ].map(([cls, n, l]) => `<div class="kpi ${cls}"><div class="n">${(n || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join("");
}

function shown() {
  const q = filters.q.trim().toLowerCase();
  return DATA.volunteers.filter(v =>
    (!filters.region || v.region === filters.region) &&
    (!filters.jk || v.jk === filters.jk) &&
    (!filters.area || v.area === filters.area) &&
    (!filters.acceptedOnly || v.accepted) &&
    (!filters.needsDecisionOnly || v.needsDecision) &&
    (!q || v.name.toLowerCase().includes(q)));
}

function render() {
  const list = shown();
  const rows = EL("rows");
  if (!list.length) { rows.innerHTML = `<tr><td colspan="8"><div class="empty">No volunteers match these filters.</div></td></tr>`; EL("count").textContent = ""; return; }
  rows.innerHTML = list.slice(0, 2000).map(v => `<tr>
    <td>${esc(v.name)}</td><td>${esc(v.region)}</td><td>${esc(v.jk) || "—"}</td>
    <td>${esc(v.area) || "—"}</td>
    <td>${v.needsDecision ? '<span class="pill rec">In reconciliation</span>' : esc(v.status)}</td>
    <td>${v.callerAssigned ? (v.callPending ? "Call pending" : "Assigned") : "—"}</td>
    <td>${v.accepted ? '<span class="pill ok">Accepted</span>' : "—"}</td>
    <td class="n">${v.age == null ? "—" : v.age}</td>
  </tr>`).join("");
  const more = list.length > 2000 ? ` (showing first 2000 — narrow with filters or Export CSV for all)` : "";
  EL("count").textContent = `${list.length.toLocaleString()} of ${DATA.volunteers.length.toLocaleString()} volunteers${more}`;
}

function exportCsv() {
  const list = shown();
  const cols = ["Name", "Region", "Jamatkhana", "Area", "Status", "Caller", "Accepted", "Age"];
  const esc2 = s => { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(",")];
  for (const v of list) lines.push([v.name, v.region, v.jk, v.area || "", v.needsDecision ? "In reconciliation" : v.status,
    v.callerAssigned ? (v.callPending ? "Call pending" : "Assigned") : "", v.accepted ? "Accepted" : "", v.age == null ? "" : v.age].map(esc2).join(","));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = `all-volunteers-${(filters.region || "all")}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

boot();
