// BI Account Resolutions (iVol Admin / Admin / Super Admin). Read-only view of duplicate groups where
// 2+ Better Impact accounts are BOTH live — the ones that must be merged in Better Impact, not here.
// Fetches /api/biresolutions and offers a CSV the BI team works from. No writes.
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const SIGNAL_LABEL = { email: "same email", phone: "same phone", name_same_jk: "same name + JK",
  name_diff_jk: "same name, different JK", name_diff_jk_age_match: "same name + age, different JK" };
let LAST = { groups: [] };

async function boot() {
  try {
    const me = await (await fetch("/.auth/me")).json();
    const chip = document.getElementById("whoami");
    if (chip) chip.textContent = (me.clientPrincipal && me.clientPrincipal.userDetails) || "";
  } catch (e) {}
  document.getElementById("refreshBtn").onclick = () => load();
  document.getElementById("regionSel").onchange = () => load();
  document.getElementById("exportBtn").onclick = exportCsv;
  await load(true);
}

async function load(firstTime) {
  const region = document.getElementById("regionSel").value;
  const params = new URLSearchParams(); if (region) params.set("region", region);
  document.getElementById("groups").innerHTML = '<div class="loading">Loading…</div>';
  document.getElementById("summary").innerHTML = "";
  document.getElementById("exportBtn").disabled = true;
  let data;
  try {
    const r = await fetch("/api/biresolutions?" + params.toString());
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || ("HTTP " + r.status)); }
    data = await r.json();
  } catch (err) {
    document.getElementById("groups").innerHTML = `<div class="loading">Could not load: ${esc(err.message)}</div>`;
    return;
  }

  const dot = document.getElementById("biDot"), status = document.getElementById("biStatus");
  if (!data.present) {
    dot.className = "dot none";
    status.innerHTML = "No Better Impact snapshot yet — ask a Super Admin to refresh the BI snapshot (on the Duplicates screen), then reload.";
    document.getElementById("groups").innerHTML = `<div class="loading">Nothing to show until a BI snapshot exists.</div>`;
    return;
  }
  dot.className = "dot " + (data.fresh ? "fresh" : "stale");
  status.textContent = `Better Impact snapshot: ${data.biCount} accounts, ${data.ageMinutes} min old${data.fresh ? "" : " (stale — ask a Super Admin to refresh for the latest)"}.`;

  if (firstTime === true) {
    const sel = document.getElementById("regionSel");
    (data.regions || []).forEach(rg => { const o = document.createElement("option"); o.value = rg; o.textContent = rg; sel.appendChild(o); });
  }
  LAST = data;
  renderSummary(data.stats);
  document.getElementById("scanInfo").textContent = `${data.stats.groups} group(s) across ${(data.regions || []).length} region(s)`;
  renderGroups(data.groups || []);
  document.getElementById("exportBtn").disabled = !(data.groups || []).length;
}

function sbox(n, label, cls) { return `<div class="sbox ${cls || ""}"><div class="n">${n}</div><div class="l">${label}</div></div>`; }
function renderSummary(s) {
  document.getElementById("summary").innerHTML =
    sbox(s.groups, "duplicate BI groups", "") +
    sbox(s.accounts, "BI accounts involved", "") +
    sbox(s.doubleCounted, "accepted in 2+ areas", s.doubleCounted ? "danger" : "");
}

function renderGroups(groups) {
  const host = document.getElementById("groups");
  if (!groups.length) { host.innerHTML = `<div class="loading">No duplicate live-BI accounts found. 🎉</div>`; return; }
  host.innerHTML = groups.map((g, i) => groupHtml(g, i)).join("");
}

function groupHtml(g, i) {
  const danger = g.acceptedInMultipleAreas;
  const why = (g.signals || []).map(s => SIGNAL_LABEL[s] || s).join(", ");
  const badges =
    `<span class="badge reg">${esc(g.region || "")}</span>` +
    `<span class="badge conf">${esc(g.topConfidence)} confidence</span>` +
    `<span class="badge">${g.liveCount} BI accounts</span>` +
    (danger ? `<span class="badge danger">accepted in 2+ areas</span>` : "");
  const rows = g.members.map(m => {
    const areaCls = (danger && m.accepted) ? "diffarea" : "";
    const state = m.accepted ? '<span class="acc">Accepted</span>' : "—";
    return `<tr>
      <td class="idcell">${esc(String(m.user_id))}</td>
      <td>${esc(m.name || "—")}</td>
      <td>${esc(m.ceremony_jk || "—")}</td>
      <td class="${areaCls}">${esc(m.final_area || "—")}</td>
      <td>${state}</td>
      <td>${esc(m.assigned_caller || "—")}</td>
      <td class="muted">${esc(m.email || m.cell_phone || "—")}</td>
    </tr>`;
  }).join("");
  return `<div class="group ${danger ? "danger" : ""}">
    <div class="ghead">${badges}<span class="why">${why ? "matched on " + esc(why) : ""}</span></div>
    <table class="dtable">
      <thead><tr><th>BI Account ID</th><th>Name</th><th>Jamatkhana</th><th>Area</th><th>Status</th><th>Caller</th><th>Contact</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// CSV: one row per BI account, grouped, so the BI team can see which accounts to merge together.
function csvCell(s) { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportCsv() {
  const cols = ["group", "region", "bi_account_id", "name", "ceremony_jk", "final_area", "accepted", "assigned_caller", "match_signal", "double_counted", "email", "cell_phone"];
  const rows = [cols.join(",")];
  (LAST.groups || []).forEach((g, i) => {
    const sig = (g.signals || []).map(s => SIGNAL_LABEL[s] || s).join("; ");
    g.members.forEach(m => {
      rows.push([i + 1, g.region, m.user_id, m.name, m.ceremony_jk, m.final_area,
        m.accepted ? "yes" : "no", m.assigned_caller || "", sig, g.acceptedInMultipleAreas ? "yes" : "no",
        m.email || "", m.cell_phone || ""].map(csvCell).join(","));
    });
  });
  const blob = new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = "bi-account-resolutions-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

if (typeof document !== "undefined") boot();
