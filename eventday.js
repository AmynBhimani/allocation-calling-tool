// Event Day Roster — read-only. Everyone placed into a session, filterable by session, area and duty,
// with a name search and a CSV export for the areas to work from on the day.
//
// "Ever Ready Team" is an area in this view, not a duty: a placed volunteer without a specific duty is
// the floating reserve. The server decides that; the client just shows it, keeping the home area beside
// the name so an area lead can still see who is theirs.
const EL = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => Number(n).toLocaleString();
let DATA = { rows: [], sessions: [], areas: [], duties: [] };
const filters = { q: "", session: "", area: "", duty: "" };

function banner(msg, isErr) { const b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }

async function boot() {
  try {
    const me = await (await fetch("/.auth/me")).json();
    const cp = me && me.clientPrincipal;
    if (cp) EL("whoami").innerHTML = `<b>${esc(cp.userDetails)}</b>`;
  } catch (e) {}
  EL("q").addEventListener("input", e => { filters.q = e.target.value; render(); });
  EL("sessionSel").addEventListener("change", e => { filters.session = e.target.value; render(); });
  EL("areaSel").addEventListener("change", e => { filters.area = e.target.value; render(); });
  EL("dutySel").addEventListener("change", e => { filters.duty = e.target.value; render(); });
  EL("clearBtn").addEventListener("click", () => {
    filters.q = ""; filters.session = ""; filters.area = ""; filters.duty = "";
    EL("q").value = ""; EL("sessionSel").value = ""; EL("areaSel").value = ""; EL("dutySel").value = "";
    render();
  });
  EL("exportBtn").addEventListener("click", exportCsv);
  await load();
}

async function load() {
  EL("count").textContent = "Loading\u2026";
  try {
    const r = await fetch("/api/eventday");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status));
    DATA = await r.json();
    fillSelect("sessionSel", DATA.sessions, "All sessions");
    fillSelect("areaSel", DATA.areas, "All areas");
    fillSelect("dutySel", DATA.duties, "All duties");
    EL("banner").hidden = true;
    render();
  } catch (e) {
    banner("Could not load: " + esc(e.message), true);
    EL("count").textContent = "Load failed.";
  }
}

function fillSelect(id, values, allLabel) {
  const sel = EL(id), keep = sel.value;
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>`
    + (values || []).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if (keep && (values || []).indexOf(keep) >= 0) sel.value = keep;
}

function shown() {
  const q = filters.q.trim().toLowerCase();
  return (DATA.rows || []).filter(r =>
    (!filters.session || r.session === filters.session) &&
    (!filters.area || r.area === filters.area) &&
    (!filters.duty || r.duty === filters.duty) &&
    (!q || ((r.first || "") + " " + (r.last || "")).toLowerCase().includes(q)
        || (r.last || "").toLowerCase().includes(q)));
}

function render() {
  const all = DATA.rows || [];
  const rows = shown();
  EL("count").textContent = rows.length === all.length
    ? `${num(all.length)} placement(s)`
    : `${num(rows.length)} of ${num(all.length)} placement(s)`;
  EL("exportBtn").disabled = !rows.length;

  if (!all.length) {
    EL("results").innerHTML = '<div class="good">Nobody has been placed into a session yet \u2014 once session allocation has run, the roster shows here.</div>';
    return;
  }
  if (!rows.length) {
    EL("results").innerHTML = '<div class="good">No one matches those filters.</div>';
    return;
  }

  const body = rows.map(r => {
    const area = r.everReady
      ? `<span class="pill ready">${esc(r.area)}</span><span class="from">from ${esc(r.homeArea)}</span>`
      : esc(r.area);
    return "<tr>"
      + `<td>${esc(r.first)}</td>`
      + `<td>${esc(r.last)}</td>`
      + `<td>${esc(r.session)}</td>`
      + `<td>${area}</td>`
      + `<td>${r.duty ? esc(r.duty) : '<span class="small">\u2014</span>'}</td>`
      + "</tr>";
  }).join("");

  EL("results").innerHTML = '<div class="scrollx"><table class="matrix"><thead><tr>'
    + "<th>First name</th><th>Last name</th><th>Session</th><th>Area</th><th>Duty</th>"
    + `</tr></thead><tbody>${body}</tbody></table></div>`;
}

function exportCsv() {
  const rows = shown();
  if (!rows.length) return;
  const cols = ["First name", "Last name", "Session", "Area", "Duty", "Home area", "Region"];
  const q = s => { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push([r.first, r.last, r.session, r.area, r.duty || "", r.homeArea, r.region].map(q).join(","));
  }
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const tag = (filters.session || filters.area || "all").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  a.href = url; a.download = `event-day-${tag}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

document.addEventListener("DOMContentLoaded", boot);
