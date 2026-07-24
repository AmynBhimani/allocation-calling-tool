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
const filters = { q: "", session: "", area: "", duty: "", after: "" };

// Compare check-in times by minutes, not text: a stray "7:30" from older data would sort before
// "10:00" as a string and quietly land in the wrong file.
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

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
  EL("afterTime").addEventListener("input", e => { filters.after = e.target.value; render(); });
  EL("clearBtn").addEventListener("click", () => {
    filters.q = ""; filters.session = ""; filters.area = ""; filters.duty = ""; filters.after = "";
    EL("q").value = ""; EL("sessionSel").value = ""; EL("areaSel").value = ""; EL("dutySel").value = "";
    EL("afterTime").value = "";
    render();
  });
  EL("exportBtn").addEventListener("click", exportCsv);
  EL("exportBiBtn").addEventListener("click", exportBi);
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

// Presentation order: surname first, the way a check-in sheet reads. Sorted here rather than on the
// server so the table and the export can never disagree — both run through this. Someone working two
// sessions keeps their rows adjacent, in session order.
function byLastName(a, b) {
  return (a.last || "").localeCompare(b.last || "")
    || (a.first || "").localeCompare(b.first || "")
    || (a.session || "").localeCompare(b.session || "");
}

function shown() {
  const q = filters.q.trim().toLowerCase();
  const after = minutesOf(filters.after);
  return (DATA.rows || []).filter(r => {
    if (filters.session && r.session !== filters.session) return false;
    if (filters.area && r.area !== filters.area) return false;
    if (filters.duty && r.duty !== filters.duty) return false;
    if (after != null) {
      // No duty means no check-in time, so there is nothing to be "after" — they drop out rather than
      // being swept in on a blank.
      const t = minutesOf(r.checkIn);
      if (t == null || t <= after) return false;
    }
    if (q && !((r.first || "") + " " + (r.last || "")).toLowerCase().includes(q)
           && !(r.last || "").toLowerCase().includes(q)) return false;
    return true;
  }).sort(byLastName);
}

function render() {
  const all = DATA.rows || [];
  const rows = shown();
  EL("count").textContent = rows.length === all.length
    ? `${num(all.length)} placement(s)`
    : `${num(rows.length)} of ${num(all.length)} placement(s)`;
  EL("exportBtn").disabled = !rows.length;

  // Write-ins carry no Better Impact id, so they can't go in a BI file. Say so up front rather than
  // letting a smaller-than-expected export be discovered later.
  const noBi = rows.filter(r => r.noBi).length;
  EL("exportBiBtn").disabled = !(rows.length - noBi);
  EL("binote").textContent = !rows.length ? ""
    : noBi
      ? `Better Impact export: ${num(rows.length - noBi)} row(s) \u2014 ${num(noBi)} write-in(s) left out, they have no Better Impact account.`
      : `Better Impact export: ${num(rows.length)} row(s).`;

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
      + `<td>${r.noBi ? '<span class="small" title="Write-in \u2014 no Better Impact account">' + esc(r.visitId) + "</span>" : esc(r.visitId)}</td>`
      + `<td>${esc(r.session)}</td>`
      + `<td>${area}</td>`
      + `<td>${r.duty ? esc(r.duty) : '<span class="small">\u2014</span>'}</td>`
      + `<td>${r.checkIn ? esc(r.checkIn) : '<span class="small">\u2014</span>'}</td>`
      + "</tr>";
  }).join("");

  EL("results").innerHTML = '<div class="scrollx"><table class="matrix"><thead><tr>'
    + "<th>First name</th><th>Last name</th><th>Visit ID</th><th>Session</th><th>Area</th><th>Duty</th><th>Check-in</th>"
    + `</tr></thead><tbody>${body}</tbody></table></div>`;
}

function csvQuote(s) { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

function download(lines, tag) {
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = tag;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function fileTag(prefix) {
  const bits = [filters.session || filters.area || "all"];
  if (filters.after) bits.push("after-" + filters.after.replace(":", ""));
  return prefix + "-" + bits.join("-").replace(/[^a-z0-9]+/gi, "-").toLowerCase()
    + "-" + new Date().toISOString().slice(0, 10) + ".csv";
}

function exportCsv() {
  const rows = shown();
  if (!rows.length) return;
  const cols = ["First name", "Last name", "Visit ID", "Session", "Area", "Duty", "Check-in", "Home area", "Region"];
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push([r.first, r.last, r.visitId, r.session, r.area, r.duty || "", r.checkIn || "", r.homeArea, r.region].map(csvQuote).join(","));
  }
  download(lines, fileTag("event-day"));
}

// Exactly what Better Impact needs and nothing else. Write-ins are left out: their id is a local
// placeholder, and feeding it to BI would create rows that match no account.
function exportBi() {
  const rows = shown().filter(r => !r.noBi);
  if (!rows.length) return;
  const lines = ["First name,Last name,Visit ID"];
  for (const r of rows) lines.push([r.first, r.last, r.visitId].map(csvQuote).join(","));
  download(lines, fileTag("better-impact"));
}

document.addEventListener("DOMContentLoaded", boot);
