let DATA = { volunteers: [], tiles: null };
const filters = { region: "", jk: "", area: "", group: "", q: "", acceptedOnly: false, needsDecisionOnly: false };
const EL = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LEADERSHIP = "Leadership - Do Not Allocate";

let CAN_ACCEPT = false;          // admin/superadmin only
const SELECTED = new Map();      // user_id -> { region, name } (persists across filter changes)
const byId = (id) => DATA.volunteers.find(v => String(v.id) === String(id));
// Only people who could actually be accepted are selectable: allocated, not already accepted,
// not contested, not leadership.
const eligible = (v) => !!v.area && !v.accepted && !v.needsDecision && v.status !== LEADERSHIP;

function banner(msg, isErr) { const b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }

async function boot() {
  try {
    const me = await (await fetch("/.auth/me")).json(); const cp = me && me.clientPrincipal;
    if (cp) { EL("whoami").innerHTML = `<b>${esc(cp.userDetails)}</b>`; const roles = cp.userRoles || []; CAN_ACCEPT = roles.includes("superadmin") || roles.includes("admin"); }
  } catch (e) {}
  ["BC", "Prairies", "Edmonton"].forEach(r => { const o = document.createElement("option"); o.value = r; o.textContent = r; EL("regionSel").appendChild(o); });
  EL("regionSel").addEventListener("change", e => { filters.region = e.target.value; load(); });
  EL("jkSel").addEventListener("change", e => { filters.jk = e.target.value; render(); });
  EL("areaSel").addEventListener("change", e => { filters.area = e.target.value; render(); });
  EL("groupSel").addEventListener("change", e => { filters.group = e.target.value; render(); });
  EL("q").addEventListener("input", e => { filters.q = e.target.value; render(); });
  EL("acceptedOnly").addEventListener("change", e => { filters.acceptedOnly = e.target.checked; render(); });
  EL("needsDecisionOnly").addEventListener("change", e => { filters.needsDecisionOnly = e.target.checked; render(); });
  EL("exportBtn").addEventListener("click", exportCsv);
  if (CAN_ACCEPT) {
    EL("acceptBar").hidden = false;
    // add the select-all header cell
    const th = document.createElement("th"); th.style.width = "28px";
    th.innerHTML = '<input type="checkbox" id="selAll" title="Select all shown & eligible">';
    EL("theadRow").insertBefore(th, EL("theadRow").firstChild);
    EL("selAll").addEventListener("change", toggleSelectAll);
    EL("clearSelBtn").addEventListener("click", () => { SELECTED.clear(); render(); updateBar(); });
    EL("markAcceptedBtn").addEventListener("click", openAcceptModal);
    EL("acceptCancel").addEventListener("click", () => { EL("acceptModal").style.display = "none"; });
    EL("acceptConfirm").addEventListener("click", doBulkAccept);
  }
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
    (!filters.group || matchesGroup(v, filters.group)) &&
    (!q || v.name.toLowerCase().includes(q)));
}
// Special-group filter: IFF (interfaith list), Seniors (>65), Young (5–13). Age-based ones need an age on file.
function matchesGroup(v, g) {
  if (g === "iff") return !!v.iff;
  if (g === "seniors") return v.age != null && v.age > 65;
  if (g === "young") return v.age != null && v.age >= 5 && v.age <= 13;
  return true;
}

function render() {
  const list = shown();
  const rows = EL("rows");
  const cols = CAN_ACCEPT ? 9 : 8;
  if (!list.length) { rows.innerHTML = `<tr><td colspan="${cols}"><div class="empty">No volunteers match these filters.</div></td></tr>`; EL("count").textContent = ""; if (CAN_ACCEPT) updateBar(); return; }
  rows.innerHTML = list.slice(0, 2000).map(v => {
    const cell = CAN_ACCEPT
      ? (eligible(v)
        ? `<td><input type="checkbox" class="selbox" data-id="${esc(v.id)}"${SELECTED.has(String(v.id)) ? " checked" : ""}></td>`
        : `<td><input type="checkbox" disabled title="${v.accepted ? "Already accepted" : v.needsDecision ? "In reconciliation — resolve first" : !v.area ? "Not allocated to an area yet" : "Not eligible"}"></td>`)
      : "";
    return `<tr>${cell}
    <td>${esc(v.name)}</td><td>${esc(v.region)}</td><td>${esc(v.jk) || "—"}</td>
    <td>${esc(v.area) || "—"}</td>
    <td>${v.needsDecision ? '<span class="pill rec">In reconciliation</span>' : esc(v.status)}</td>
    <td>${v.callerAssigned ? (v.callPending ? "Call pending" : "Assigned") : "—"}</td>
    <td>${v.accepted ? '<span class="pill ok">Accepted</span>' : "—"}</td>
    <td class="n">${v.age == null ? "—" : v.age}</td>
  </tr>`;
  }).join("");
  if (CAN_ACCEPT) {
    rows.querySelectorAll(".selbox").forEach(cb => cb.addEventListener("change", () => {
      const v = byId(cb.dataset.id);
      if (cb.checked && v) SELECTED.set(String(v.id), { region: v.region, name: v.name });
      else SELECTED.delete(String(cb.dataset.id));
      updateBar(); syncSelAll();
    }));
    syncSelAll();
  }
  const more = list.length > 2000 ? ` (showing first 2000 — narrow with filters or Export CSV for all)` : "";
  EL("count").textContent = `${list.length.toLocaleString()} of ${DATA.volunteers.length.toLocaleString()} volunteers${more}`;
  if (CAN_ACCEPT) updateBar();
}

// Eligible people in the current filtered view (what select-all acts on; capped at the 2000 shown).
function shownEligible() { return shown().slice(0, 2000).filter(eligible); }
function toggleSelectAll(e) {
  const on = e.target.checked;
  shownEligible().forEach(v => { if (on) SELECTED.set(String(v.id), { region: v.region, name: v.name }); else SELECTED.delete(String(v.id)); });
  render(); updateBar();
}
function syncSelAll() {
  const el = EL("selAll"); if (!el) return;
  const elig = shownEligible();
  el.checked = elig.length > 0 && elig.every(v => SELECTED.has(String(v.id)));
}
function updateBar() {
  const n = SELECTED.size;
  EL("selCount").textContent = n + " selected";
  EL("markAcceptedBtn").disabled = n === 0;
}

function openAcceptModal() {
  const n = SELECTED.size; if (!n) return;
  const names = [...SELECTED.values()].map(x => x.name);
  const sample = names.slice(0, 40).map(esc).join(", ") + (names.length > 40 ? `, …and ${names.length - 40} more` : "");
  EL("acceptWho").innerHTML = `<b>${n}</b> ${n === 1 ? "person" : "people"}: ${sample}`;
  EL("acceptConfirmN").textContent = n;
  EL("acceptModal").style.display = "flex";
}

async function doBulkAccept() {
  const items = [...SELECTED.entries()].map(([user_id, x]) => ({ user_id, region: x.region }));
  if (!items.length) return;
  EL("acceptConfirm").disabled = true;
  try {
    const r = await fetch("/api/bulkaccept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    EL("acceptModal").style.display = "none";
    SELECTED.clear();
    const sk = d.skipped || {}; const skips = Object.entries(sk).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(", ");
    banner(`Marked <b>${d.acceptedCount}</b> as accepted.` + (skips ? ` Skipped: ${esc(skips)}.` : ""), false);
    await load();   // refresh so the newly-accepted show as Accepted
  } catch (e) { banner("Bulk accept failed: " + e.message, true); }
  finally { EL("acceptConfirm").disabled = false; }
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
