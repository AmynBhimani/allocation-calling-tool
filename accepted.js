const AREAS = ["Safety & Flow Management","Parking & Transportation","Reception & Hospitality",
  "Seniors & Mobility","Food Services","Layout & Logistics","Registration & Access","Medical Services","Diverse Abilities Support",
  "Finance & Procurement","Environmental Sustainability","Memorabilia & Design","Jamati Preparation","Volunteer Engagement","Operations Centre","Communications"];
let CAN_UNDO = false;   // Duty Team / Admin / Super Admin. Quarterbacks + Leadership may look, not act.
let DATA = { volunteers: [] };
const filters = { region: "", jk: "", area: "", group: "", q: "", notInBi: false, duty: "", dutyMode: "assigned" };
const EL = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function banner(msg, isErr) { const b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }

async function boot() {
  try {
    const me = await (await fetch("/.auth/me")).json(); const cp = me && me.clientPrincipal;
    if (cp) {
      EL("whoami").innerHTML = `<b>${esc(cp.userDetails)}</b>`;
      const roles = cp.userRoles || [];
      CAN_UNDO = ["superadmin", "admin", "dutyteam"].some(r => roles.includes(r));
    }
  } catch (e) {}
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
  EL("dutySel").addEventListener("change", e => { filters.duty = e.target.value; render(); });
  EL("dutyModeSel").addEventListener("change", e => { filters.dutyMode = e.target.value; render(); });
  EL("exportBtn").addEventListener("click", exportCsv);
  EL("exportEmailBtn").addEventListener("click", exportEmails);
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

  // Duty list = every duty that appears in the data, either as an assignment or as a captured interest.
  const duties = [...new Set([
    ...DATA.volunteers.map(v => v.assignedDuty).filter(Boolean),
    ...DATA.volunteers.flatMap(v => v.duties || []),
  ].map(d => String(d).trim()).filter(Boolean))].sort();
  EL("dutySel").innerHTML = '<option value="">All duties</option>' + duties.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
  EL("dutySel").value = filters.duty;
  // Label each mode with how many people it covers, so an empty result is never a mystery.
  const nAssigned = DATA.volunteers.filter(v => v.assignedDuty).length;
  const nInterest = DATA.volunteers.filter(v => (v.duties || []).length).length;
  EL("dutyModeSel").innerHTML =
      `<option value="assigned">Duty assigned (${nAssigned.toLocaleString()})</option>`
    + `<option value="interest">Duty of interest (${nInterest.toLocaleString()})</option>`
    + `<option value="either">Assigned or interested</option>`;
  EL("dutyModeSel").value = filters.dutyMode;
  EL("exportEmailBtn").hidden = !DATA.canEmail;
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
  panel.innerHTML = `<h2>${esc(d.name)}</h2><div class="sub2">${esc(d.region)}${d.area ? " · " + esc(d.area) : ""}</div>${contact}${dutiesHtml}${prefHtml}${logHtml}${moveHtml(d)}${undoHtml(d)}`;
  if (CAN_UNDO) { wireMove(d); wireUndo(d); }
}

// Move an accepted volunteer to a different area, keeping them accepted. Distinct from "undo acceptance"
// below: nothing about their acceptance changes, only the area (and the now-cleared duty). Blocked while
// they're on a lineup — the server enforces it too, this just says so up front.
function moveHtml(d) {
  if (!CAN_UNDO) return "";
  const opts = AREAS.filter(a => a !== d.area).map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  const locked = !!d.onLineup;
  return `<div class="dsec move">
    <h4>Move to another area</h4>
    <div class="dmuted">Keep them accepted, but change their area. Their current duty is cleared and reset for the new area.${locked ? " <b>Unavailable while they\u2019re on a lineup</b> \u2014 take them off the lineup first." : ""}</div>
    <select id="mArea"${locked ? " disabled" : ""}><option value="">Move to which area?</option>${opts}</select>
    <input id="mNote" type="text" maxlength="300" placeholder="Note (optional)"${locked ? " disabled" : ""}>
    <button class="btn-ghost" id="mGo" disabled>Move to area</button>
    <div id="mOut"></div>
  </div>`;
}

function wireMove(d) {
  const area = EL("mArea"), go = EL("mGo");
  if (!area || !go) return;
  const sync = () => { go.disabled = !area.value; };
  area.addEventListener("change", sync);
  go.addEventListener("click", () => applyMove(d));
  sync();
}

async function applyMove(d) {
  const referral_area = EL("mArea").value;
  const note = EL("mNote").value;
  const out = EL("mOut");
  if (!referral_area) return;
  if (!confirm(`Move ${d.name} to ${referral_area}?\n\nThey stay accepted. Their current duty is cleared and reset for the new area.`)) return;
  out.innerHTML = `<div class="dmuted">Saving\u2026</div>`;
  EL("mGo").disabled = true;
  try {
    const r = await fetch("/api/accepted", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "move_area", user_id: DETAIL_ID, region: d.region, referral_area, note }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    await load();                        // still accepted, now in the new area
    const id = DETAIL_ID, region = d.region;
    setTimeout(() => { if (String(DETAIL_ID) === String(id)) selectVolunteer(id, region); }, 200);
  } catch (e) {
    out.innerHTML = `<div class="derr">${esc(e.message)}</div>`;
    EL("mGo").disabled = false;
  }
}

// Undoing an acceptance. Which ending applies is the volunteer's answer, not ours, so the control
// asks what they said rather than offering three buttons of equal weight.
function undoHtml(d) {
  if (!CAN_UNDO) return "";
  const opts = AREAS.filter(a => a !== d.area).map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  return `<div class="dsec undo">
    <h4>Undo acceptance</h4>
    <div class="dmuted">They said yes, then told you they can\u2019t. Their duty is cleared either way \u2014 what they want decides the rest.</div>
    <select id="uAction">
      <option value="">Choose what they said\u2026</option>
      <option value="withdraw">Withdrew \u2014 not volunteering at all</option>
      <option value="decline_refer">Would serve, but not in this area \u2014 refer them on</option>
      <option value="repool">Doesn\u2019t want this area \u2014 back to the pool</option>
    </select>
    <select id="uArea" hidden><option value="">Refer to which area?</option>${opts}</select>
    <input id="uNote" type="text" maxlength="300" placeholder="Note (optional)">
    <button class="btn-ghost" id="uGo" disabled>Apply</button>
    <div id="uOut"></div>
  </div>`;
}

function wireUndo(d) {
  const act = EL("uAction"), area = EL("uArea"), go = EL("uGo");
  if (!act || !area || !go) return;
  const sync = () => {
    const a = act.value;
    area.hidden = a !== "decline_refer";
    go.disabled = !a || (a === "decline_refer" && !area.value);
    go.textContent = a === "withdraw" ? "Mark withdrawn"
      : a === "decline_refer" ? "Refer to another area"
      : a === "repool" ? "Return to the pool" : "Apply";
  };
  act.addEventListener("change", sync);
  area.addEventListener("change", sync);
  go.addEventListener("click", () => applyUndo(d));
  sync();
}

async function applyUndo(d) {
  const action = EL("uAction").value;
  const referral_area = EL("uArea").value;
  const note = EL("uNote").value;
  const out = EL("uOut");
  const area = d.area || "their area";
  const msg = action === "withdraw"
    ? `Mark ${d.name} as withdrawn?\n\nThey come off the accepted list and their duty is cleared.`
    : action === "decline_refer"
      ? `Refer ${d.name} to ${referral_area}?\n\n${area} is recorded as declined, their duty is cleared, and the receiving area\u2019s quarterback picks them up.`
      : `Return ${d.name} to the allocation pool?\n\n${area} is cleared and recorded as declined, so the next allocation won\u2019t put them back there. Their duty is cleared.`;
  if (!confirm(msg)) return;
  out.innerHTML = `<div class="dmuted">Saving\u2026</div>`;
  EL("uGo").disabled = true;
  try {
    const r = await fetch("/api/accepted", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, user_id: DETAIL_ID, region: d.region, referral_area, note }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    await load();                        // they are off the accepted list now
    DETAIL_ID = null;
    const panel = EL("detailPanel");
    panel.className = "detailcard";
    panel.innerHTML = `<h2>${esc(d.name)}</h2><div class="uok">No longer on the accepted list. ${esc(j.note || "")}</div>`;
  } catch (err) {
    out.innerHTML = `<div class="uerr">Could not save: ${esc(err.message)}</div>`;
    EL("uGo").disabled = false;
  }
}
function shown() {
  const q = filters.q.trim().toLowerCase();
  return DATA.volunteers.filter(v =>
    (!filters.region || v.region === filters.region) &&
    (!filters.jk || v.jk === filters.jk) &&
    (!filters.area || v.area === filters.area) &&
    (!filters.group || matchesGroup(v, filters.group)) &&
    (!filters.notInBi || !v.entered) &&
    (!filters.duty || matchesDuty(v, filters.duty, filters.dutyMode)) &&
    (!q || v.name.toLowerCase().includes(q)));
}

// Duty match. "assigned" = the duty a quarterback gave them (v.assignedDuty). "interest" = a duty a
// caller captured (v.duties). Kept apart on purpose: emailing someone about a duty they merely
// expressed interest in is not the same as emailing the people actually rostered on it.
function matchesDuty(v, duty, mode) {
  const isAssigned = String(v.assignedDuty || "") === duty;
  const isInterest = (v.duties || []).some(d => String(d) === duty);
  if (mode === "assigned") return isAssigned;
  if (mode === "interest") return isInterest;
  return isAssigned || isInterest;
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
  renderMailStats(list);
}

// Normalised for deduping only — the address is exported as entered.
const emailKey = (v) => String(v.email || "").trim().toLowerCase();

// Families share one email address in this data, so a mailing list has to be per-ADDRESS, not
// per-person: otherwise a household of three gets three copies of the same email.
function mailRows(list) {
  const byEmail = new Map();
  for (const v of list) {
    const k = emailKey(v);
    if (!k) continue;
    let e = byEmail.get(k);
    if (!e) { e = { email: String(v.email).trim(), names: [], regions: new Set(), jks: new Set(), areas: new Set(), duties: new Set() }; byEmail.set(k, e); }
    e.names.push(v.name);
    if (v.region) e.regions.add(v.region);
    if (v.jk) e.jks.add(v.jk);
    if (v.area) e.areas.add(v.area);
    if (v.assignedDuty) e.duties.add(v.assignedDuty);
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

function renderMailStats(list) {
  const el = EL("mailStats"); if (!el) return;
  if (!DATA.canEmail) { el.textContent = ""; return; }
  const withEmail = list.filter(v => emailKey(v)).length;
  const missing = list.length - withEmail;
  const unique = mailRows(list).length;
  el.innerHTML = `${withEmail.toLocaleString()} of ${list.length.toLocaleString()} shown have an email address`
    + ` \u00b7 <b>${unique.toLocaleString()}</b> unique address${unique === 1 ? "" : "es"} to email`
    + (unique && unique !== withEmail ? ` <span title="Family members often share one address — the email export sends one row per address, not per person.">(some are shared by more than one volunteer)</span>` : "")
    + (missing ? ` \u00b7 <b>${missing.toLocaleString()}</b> with no email address on file, not in the export` : "");
}

// One row per unique address: what a mailing list actually needs.
function exportEmails() {
  const rows = mailRows(shown());
  if (!rows.length) { banner("No email addresses in the current filter.", true); return; }
  const cols = ["Email", "Volunteers", "Count", "Regions", "Jamatkhanas", "Areas", "Duties assigned"];
  const esc2 = s => { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push([r.email, r.names.join("; "), r.names.length, [...r.regions].join("; "),
    [...r.jks].join("; "), [...r.areas].join("; "), [...r.duties].join("; ")].map(esc2).join(","));
  download(lines, `volunteer-emails-${new Date().toISOString().slice(0, 10)}.csv`);
}

function download(lines, filename) {
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function exportCsv() {
  const list = shown();
  const cols = ["Name", "Region", "Jamatkhana", "Area", "Age", "In Better Impact", "Accepted", "Duty assigned", "Duties of Interest"]
    .concat(DATA.canEmail ? ["Email"] : []);
  const esc2 = s => { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [cols.join(",")];
  for (const v of list) lines.push([v.name, v.region, v.jk, v.area || "", v.age == null ? "" : v.age, v.entered ? "Yes" : "No",
    fmtDate(v.acceptedAt), v.assignedDuty || "", (v.duties || []).join("; ")]
    .concat(DATA.canEmail ? [v.email || ""] : []).map(esc2).join(","));
  download(lines, `accepted-volunteers-${new Date().toISOString().slice(0, 10)}.csv`);
}

boot();
