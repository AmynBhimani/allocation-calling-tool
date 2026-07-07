let DATA = { callers: [] };
const filters = { region: "", area: "", q: "", pendingOnly: false, staleOnly: false };
const EL = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const DAY = 24 * 60 * 60 * 1000;

function banner(msg, isErr) { const b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }

async function boot() {
  try { const me = await (await fetch("/.auth/me")).json(); const cp = me && me.clientPrincipal; if (cp) EL("whoami").innerHTML = `<b>${esc(cp.userDetails)}</b>`; } catch (e) {}
  EL("regionSel").addEventListener("change", e => { filters.region = e.target.value; render(); });
  EL("areaSel").addEventListener("change", e => { filters.area = e.target.value; render(); });
  EL("q").addEventListener("input", e => { filters.q = e.target.value; render(); });
  EL("pendingOnly").addEventListener("change", e => { filters.pendingOnly = e.target.checked; render(); });
  EL("staleOnly").addEventListener("change", e => { filters.staleOnly = e.target.checked; render(); });
  EL("exportBtn").addEventListener("click", exportCsv);
  await load();
}

async function load() {
  EL("count").textContent = "Loading…";
  try {
    const r = await fetch("/api/calleractivity");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status));
    DATA = await r.json();
    EL("banner").hidden = true;
    buildDropdowns();
    render();
  } catch (e) { banner("Could not load: " + e.message, true); EL("count").textContent = "Load failed."; }
}

function buildDropdowns() {
  const regions = [...new Set(DATA.callers.flatMap(c => c.regions))].sort();
  const areas = [...new Set(DATA.callers.flatMap(c => c.areas))].sort();
  EL("regionSel").innerHTML = '<option value="">All regions</option>' + regions.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
  EL("areaSel").innerHTML = '<option value="">All areas</option>' + areas.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  EL("regionSel").value = filters.region; EL("areaSel").value = filters.area;
}

const isStale = (c) => !c.lastActive || (Date.now() - new Date(c.lastActive).getTime()) >= DAY;

function shown() {
  const q = filters.q.trim().toLowerCase();
  return DATA.callers.filter(c =>
    (!filters.region || c.regions.includes(filters.region)) &&
    (!filters.area || c.areas.includes(filters.area)) &&
    (!filters.pendingOnly || c.pending > 0) &&
    (!filters.staleOnly || isStale(c)) &&
    (!q || c.email.toLowerCase().includes(q)));
}

function renderTiles(list) {
  const filtered = list.length !== DATA.callers.length;
  const sum = (k) => list.reduce((s, c) => s + (c[k] || 0), 0);
  EL("kpis").innerHTML = [
    ["", list.length, filtered ? "Callers (filtered)" : "Callers"],
    ["callable", sum("assigned"), "Assigned"],
    ["stable", sum("completed"), "Completed"],
    ["recon", sum("pending"), "Pending"],
  ].map(([cls, n, l]) => `<div class="kpi ${cls}"><div class="n">${(n || 0).toLocaleString()}</div><div class="l">${l}</div></div>`).join("");
}

function fmtWhen(s) {
  if (!s) return '<span class="stale">never</span>';
  const d = new Date(s); if (isNaN(d)) return "—";
  const ago = Date.now() - d.getTime();
  const txt = d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return ago >= DAY ? `<span class="stale">${esc(txt)}</span>` : esc(txt);
}

function render() {
  const list = shown();
  renderTiles(list);
  const rows = EL("rows");
  if (!list.length) { rows.innerHTML = `<tr><td colspan="7"><div class="empty">No callers match these filters.</div></td></tr>`; EL("count").textContent = ""; return; }
  rows.innerHTML = list.map(c => `<tr>
    <td>${esc(c.email)}</td>
    <td>${c.areas.map(esc).join(", ") || "—"}</td>
    <td>${c.regions.map(esc).join(", ") || "—"}</td>
    <td class="n">${(c.assigned || 0).toLocaleString()}</td>
    <td class="n">${(c.completed || 0).toLocaleString()}</td>
    <td class="n">${(c.pending || 0).toLocaleString()}</td>
    <td>${fmtWhen(c.lastActive)}</td>
  </tr>`).join("");
  EL("count").textContent = `${list.length.toLocaleString()} of ${DATA.callers.length.toLocaleString()} callers`;
}

function exportCsv() {
  const list = shown();
  const cols = ["Caller", "Areas", "Regions", "Assigned", "Completed", "Pending", "Last active"];
  const esc2 = s => { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(",")];
  for (const c of list) lines.push([c.email, c.areas.join("; "), c.regions.join("; "), c.assigned, c.completed, c.pending, c.lastActive ? new Date(c.lastActive).toLocaleString() : ""].map(esc2).join(","));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = `caller-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

boot();
