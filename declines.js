const AREAS = ["Safety & Flow Management","Parking & Transportation","Reception & Hospitality",
  "Seniors & Mobility","Food Services","Layout & Logistics","Registration & Access","Medical Services","Diverse Abilities Support",
  "Finance & Procurement","Environmental Sustainability","Memorabilia & Design","Jamati Preparation","Volunteer Engagement","Operations Centre","Communications"];
let CAN_REOPEN = false;   // Duty Team / Admin / Super Admin. Quarterbacks + Leadership may look, not act.
let VIEW = { volunteers: [], canEmail: false };
const selected = {};      // user_id -> true
const filters = { q: "", region: "" };
const EL = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => Number(n).toLocaleString();

function banner(msg, isErr) { const b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }

async function boot() {
  try {
    const me = await (await fetch("/.auth/me")).json(); const cp = me && me.clientPrincipal;
    if (cp) {
      EL("whoami").innerHTML = `<b>${esc(cp.userDetails)}</b>`;
      const roles = cp.userRoles || [];
      CAN_REOPEN = ["superadmin", "admin", "dutyteam"].some(r => roles.includes(r));
    }
  } catch (e) {}
  AREAS.forEach(a => { const o = document.createElement("option"); o.value = a; o.textContent = a; EL("areaSel").appendChild(o); });
  ["BC", "Prairies", "Edmonton"].forEach(r => { const o = document.createElement("option"); o.value = r; o.textContent = r; EL("regionSel").appendChild(o); });
  EL("areaSel").addEventListener("change", refreshBtn);
  EL("reopenBtn").addEventListener("click", reopen);
  EL("q").addEventListener("input", e => { filters.q = e.target.value; render(); });
  EL("regionSel").addEventListener("change", e => { filters.region = e.target.value; render(); });
  if (!CAN_REOPEN) {
    EL("areaSel").disabled = true; EL("reopenBtn").hidden = true; EL("selcount").hidden = true;
    EL("acthint").hidden = false;
    EL("acthint").textContent = "You can view withdrawals, but only the Duty Team, an Admin, or a Super Admin can reopen them.";
  }
  await load();
}

async function load() {
  EL("count").textContent = "Loading\u2026";
  try {
    const r = await fetch("/api/accepted?view=withdrawn");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status));
    VIEW = await r.json();
    EL("banner").hidden = true;
    render();
  } catch (e) { banner("Could not load: " + e.message, true); EL("count").textContent = "Load failed."; }
}

function matches(v) {
  if (filters.region && v.region !== filters.region) return false;
  if (filters.q) { const q = filters.q.toLowerCase(); if ((v.name || "").toLowerCase().indexOf(q) < 0 && (v.jk || "").toLowerCase().indexOf(q) < 0) return false; }
  return true;
}

function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch (e) { return ""; }
}

function render() {
  const all = VIEW.volunteers || [];
  const rows = all.filter(matches);
  EL("count").textContent = rows.length === all.length
    ? `${num(all.length)} withdrawn`
    : `${num(rows.length)} of ${num(all.length)} withdrawn`;

  if (!all.length) {
    EL("results").innerHTML = '<div class="good">No withdrawn volunteers \u2014 nothing to reopen.</div>';
    refreshBtn(); updateSelCount(); return;
  }

  const canPick = CAN_REOPEN;
  const head = "<tr>"
    + (canPick ? '<th class="c"><input type="checkbox" id="selAll" title="Select all shown"></th>' : "")
    + "<th>Name</th><th>Region</th><th>Jamatkhana</th><th>Withdrew from</th><th>When</th>"
    + (VIEW.canEmail ? "<th>Email</th>" : "")
    + "</tr>";
  const body = rows.map(v => {
    const id = String(v.id);
    const bi = v.enteredInBi ? ' <span class="small" style="color:#9a6a12">\u00b7 in Better Impact</span>' : "";
    const note = v.withdrewNote ? ` <span class="small" title="${esc(v.withdrewNote)}">\u00b7 note</span>` : "";
    return `<tr data-id="${esc(id)}">`
      + (canPick ? `<td class="c"><input type="checkbox" class="rowchk" data-id="${esc(id)}"${selected[id] ? " checked" : ""}></td>` : "")
      + `<td>${esc(v.name)}${bi}</td>`
      + `<td>${esc(v.region)}</td>`
      + `<td>${esc(v.jk || "\u2014")}</td>`
      + `<td>${esc(v.area || "\u2014")}</td>`
      + `<td>${esc(fmtDate(v.withdrewAt)) || "\u2014"}${note}</td>`
      + (VIEW.canEmail ? `<td class="small">${esc(v.email || "")}</td>` : "")
      + "</tr>";
  }).join("");
  EL("results").innerHTML = `<div class="scrollx"><table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;

  if (canPick) {
    const selAll = EL("selAll");
    if (selAll) selAll.addEventListener("change", (e) => { rows.forEach(v => { selected[String(v.id)] = e.target.checked; }); render(); });
    Array.prototype.forEach.call(document.querySelectorAll(".rowchk"), (chk) => {
      chk.addEventListener("change", (e) => { selected[e.target.getAttribute("data-id")] = e.target.checked; refreshBtn(); updateSelCount(); });
    });
  }
  refreshBtn(); updateSelCount();
}

function selectedItems() {
  const byId = {};
  (VIEW.volunteers || []).forEach(v => { byId[String(v.id)] = v; });
  return Object.keys(selected).filter(k => selected[k] && byId[k]).map(k => ({ user_id: byId[k].id, region: byId[k].region }));
}

function updateSelCount() {
  if (!CAN_REOPEN) return;
  const n = selectedItems().length;
  EL("selcount").textContent = n ? `${num(n)} selected` : "None selected";
}

function refreshBtn() {
  if (!CAN_REOPEN) return;
  const n = selectedItems().length;
  const area = EL("areaSel").value;
  EL("reopenBtn").disabled = !(n > 0 && area);
  EL("reopenBtn").textContent = n && area ? `Reopen ${num(n)} into ${area}` : "Reopen selected";
}

async function reopen() {
  const area = EL("areaSel").value;
  const items = selectedItems();
  if (!area || !items.length) return;
  if (!confirm(`Reopen ${items.length} volunteer(s) as accepted in ${area}?`)) return;
  EL("reopenBtn").disabled = true; EL("reopenBtn").textContent = "Reopening\u2026";
  try {
    const r = await fetch("/api/accepted", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reopen_accept", area, items }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    Object.keys(selected).forEach(k => delete selected[k]);
    await load();
    banner(d.note || "Done.", false);
  } catch (e) {
    banner("Reopen failed: " + e.message, true);
    refreshBtn();
  }
}

document.addEventListener("DOMContentLoaded", boot);
