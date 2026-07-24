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

// DatabaseUserId -> Visit Registration Number, from a Better Impact profile export. Held in memory
// only: it's Better Impact's data, it changes as people register, and storing a stale copy here would
// be worse than re-attaching the file.
let REG = null;

// Better Impact writes the literal text "None" into empty custom fields, and a genuinely blank cell
// means the same thing. Either way there is no registration number to export.
function cleanReg(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || /^(none|n\/?a|null)$/i.test(s)) return "";
  return s;
}

// What goes in the Visit ID column: the registration number once a file is attached, otherwise the
// Better Impact account id we already hold.
function visitIdOf(r) {
  if (!REG) return r.visitId;
  return REG.map[String(r.visitId)] || "";
}

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
  EL("regFile").addEventListener("change", (e) => {
    const f = (e.target.files || [])[0];
    if (f) loadRegFile(f);
  });
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

  // Write-ins carry no Better Impact id, so they can't go in a BI file. Once a registration file is
  // attached, anyone it has no number for can't either. Say so up front rather than letting a
  // smaller-than-expected export be discovered later.
  const noBi = rows.filter(r => r.noBi).length;
  const missingReg = REG ? rows.filter(r => !r.noBi && !visitIdOf(r)).length : 0;
  const exportable = rows.length - noBi - missingReg;
  EL("exportBiBtn").disabled = !exportable;
  EL("binote").innerHTML = !rows.length ? ""
    : `Better Impact export: ${num(exportable)} row(s)`
      + (noBi ? ` \u00b7 ${num(noBi)} write-in(s) left out, no Better Impact account` : "")
      + (missingReg ? ` \u00b7 <b style="color:#a83729">${num(missingReg)} left out, no visit registration number</b>` : "")
      + (REG ? " \u00b7 using visit registration numbers." : " \u00b7 using Better Impact account ids \u2014 attach a profile export below for registration numbers.");

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
    const vid = visitIdOf(r);
    const vidCell = r.noBi
      ? `<span class="small" title="Write-in \u2014 no Better Impact account">${esc(r.visitId)}</span>`
      : vid
        ? esc(vid)
        : '<span class="small" style="color:#a83729" title="No visit registration number in the attached file">\u2014 none</span>';
    return "<tr>"
      + `<td>${esc(r.first)}</td>`
      + `<td>${esc(r.last)}</td>`
      + `<td>${vidCell}</td>`
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

// Read a Better Impact profile export and build the id -> registration-number map. Columns are found
// by what their header SAYS, not position: the custom-field header carries a long bilingual prefix that
// will not survive being renamed in Better Impact, but "visit registration number" will.
function loadRegFile(file) {
  const note = EL("regNote");
  note.textContent = "Reading \u2026";
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
      if (!rows.length) throw new Error("that sheet is empty");
      const hdr = (rows[0] || []).map(h => String(h == null ? "" : h).toLowerCase());
      const idCol = hdr.findIndex(h => h.replace(/[^a-z]/g, "") === "databaseuserid");
      const regCol = hdr.findIndex(h => h.indexOf("visit registration number") >= 0);
      if (idCol < 0) throw new Error("no DatabaseUserId column");
      if (regCol < 0) throw new Error("no Visit Registration Number column");

      const map = {};
      let withReg = 0, blank = 0;
      const seen = {};
      const shared = {};
      for (let i = 1; i < rows.length; i++) {
        const id = String((rows[i] || [])[idCol] == null ? "" : (rows[i] || [])[idCol]).trim();
        if (!id) continue;
        const reg = cleanReg((rows[i] || [])[regCol]);
        if (!reg) { blank++; continue; }
        map[id] = reg; withReg++;
        if (seen[reg]) shared[reg] = true;
        seen[reg] = true;
      }
      REG = { map: map, withReg: withReg, blank: blank, shared: Object.keys(shared).length, name: file.name };
      note.innerHTML = `<b>${esc(file.name)}</b> \u2014 ${num(withReg)} registration number(s) loaded`
        + (blank ? `, ${num(blank)} profile(s) had none` : "")
        + (REG.shared ? ` \u00b7 ${num(REG.shared)} number(s) are shared by more than one person (family registrations) \u2014 expected, but worth knowing.` : "");
      render();
    } catch (e) {
      REG = null;
      note.innerHTML = `<span style="color:#a83729">Couldn\u2019t read that file: ${esc(e.message)}.</span> `
        + "It needs a DatabaseUserId column and a Visit Registration Number column.";
      render();
    }
  };
  reader.onerror = () => { note.textContent = "Couldn\u2019t read that file."; };
  reader.readAsArrayBuffer(file);
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
    lines.push([r.first, r.last, visitIdOf(r), r.session, r.area, r.duty || "", r.checkIn || "", r.homeArea, r.region].map(csvQuote).join(","));
  }
  download(lines, fileTag("event-day"));
}

// Exactly what Better Impact needs and nothing else. A row is only written if it has a Visit ID to
// write: write-ins have no account at all, and once a registration file is attached, anyone it has no
// number for would otherwise land in the file with a blank id.
function exportBi() {
  const rows = shown().filter(r => !r.noBi && visitIdOf(r));
  if (!rows.length) return;
  const lines = ["First name,Last name,Visit ID"];
  for (const r of rows) lines.push([r.first, r.last, visitIdOf(r)].map(csvQuote).join(","));
  download(lines, fileTag("better-impact"));
}

document.addEventListener("DOMContentLoaded", boot);
