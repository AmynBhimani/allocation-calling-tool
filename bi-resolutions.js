// BI Account Resolutions (iVol Admin / Admin / Super Admin). Read-only view of duplicate groups where
// 2+ Better Impact accounts are BOTH live — the ones that must be merged in Better Impact, not here.
// Fetches /api/biresolutions and offers a CSV the BI team works from. No writes.
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const SIGNAL_LABEL = { email: "same email", phone: "same phone", name_same_jk: "same name + JK",
  name_diff_jk: "same name, different JK", name_diff_jk_age_match: "same name + age, different JK" };
let LAST = { groups: [] };
let CAN_RESOLVE = false;    // only the roles that may fold: iVol admin (their job), admin, superadmin

async function boot() {
  try {
    const me = await (await fetch("/.auth/me")).json();
    const chip = document.getElementById("whoami");
    if (chip) chip.textContent = (me.clientPrincipal && me.clientPrincipal.userDetails) || "";
    const roles = (me.clientPrincipal && me.clientPrincipal.userRoles) || [];
    CAN_RESOLVE = ["superadmin", "admin", "ivoladmin"].some(r => roles.includes(r));
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
  if (!CAN_RESOLVE) { host.querySelectorAll(".resolve").forEach(el => el.remove()); return; }
  host.querySelectorAll(".keepRadio").forEach(r => r.addEventListener("change", () => {
    const i = r.dataset.g;
    host.querySelector(`.rprev[data-g="${i}"]`).disabled = false;
    host.querySelector(`.rgo[data-g="${i}"]`).disabled = true;      // preview before merging
    document.getElementById("rout-" + i).innerHTML = "";
  }));
  host.querySelectorAll(".rprev").forEach(b => b.addEventListener("click", () => resolve(+b.dataset.g, false)));
  host.querySelectorAll(".rgo").forEach(b => b.addEventListener("click", () => resolve(+b.dataset.g, true)));
}

// Fold the other profiles into the one the iVol admin is keeping. The kept BI id is sent as the
// declaration that unlocks the both_in_bi rule — the app still refuses a generic force.
async function resolve(i, commit) {
  const g = (LAST.groups || [])[i]; if (!g) return;
  const host = document.getElementById("groups");
  const picked = host.querySelector(`input[name="keep-${i}"]:checked`);
  if (!picked) return;
  const keep = picked.value;
  const losers = g.members.map(m => String(m.user_id)).filter(id => id !== keep);
  const winSel = host.querySelector(`.rwin[data-g="${i}"]`);
  const winner = winSel && !winSel.hidden ? winSel.value : "";
  const out = document.getElementById("rout-" + i);
  if (commit && !confirm(`Merge ${losers.length} profile(s) into ${keep}? This can't be undone from this screen.`)) return;
  out.innerHTML = '<div class="muted">Working…</div>';
  try {
    const r = await fetch("/api/biresolutions", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: g.region, survivorId: keep, loserIds: losers, biKeep: keep, winner: winner || undefined, commit: !!commit }) });
    const d = await r.json();
    if (d.error) { out.innerHTML = `<div class="rwarn">${esc(d.error)}</div>`; return; }
    const needsWinner = (d.results || []).some(x => x.needsWinner);
    if (winSel) winSel.hidden = !needsWinner;
    const bad = (d.results || []).filter(x => !x.ok);
    let html = "";
    if (d.stillLiveInBi && d.stillLiveInBi.length) html += `<div class="rwarn">${esc(d.note)}</div>`;
    else if (d.note) html += `<div class="rok">${esc(d.note)}</div>`;
    if (needsWinner) html += `<div class="rwarn">Both profiles accepted a duty \u2014 choose whose area and call history survives, then preview again.</div>`;
    else if (bad.length) html += `<div class="rwarn">Can\u2019t merge: ${bad.map(x => esc(x.loserId + " (" + (x.reason || "refused") + ")")).join(", ")}</div>`;
    if (d.mode === "commit") {
      html += `<div class="rok">Merged ${d.merged} profile(s) into ${esc(String(d.survivorId))}.</div>`;
      out.innerHTML = html;
      setTimeout(() => load(), 900);                                  // the group should drop off the list
      return;
    }
    const okCount = (d.results || []).filter(x => x.ok).length;
    if (okCount && !needsWinner) html += `<div class="rok">Ready: ${okCount} profile(s) will fold into ${esc(keep)}.</div>`;
    out.innerHTML = html;
    host.querySelector(`.rgo[data-g="${i}"]`).disabled = !(okCount && !needsWinner);
  } catch (e) {
    out.innerHTML = `<div class="rwarn">Failed: ${esc(e.message)}</div>`;
  }
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
      <td><input type="radio" name="keep-${i}" value="${esc(String(m.user_id))}" data-g="${i}" class="keepRadio" aria-label="Keep this profile"></td>
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
      <thead><tr><th title="Choose the profile you are keeping in Better Impact">Keep</th><th>BI Account ID</th><th>Name</th><th>Jamatkhana</th><th>Area</th><th>Status</th><th>Caller</th><th>Contact</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="resolve" data-r="${i}">
      <div class="rmsg" id="rmsg-${i}">Resolving this in Better Impact? Choose the profile you\u2019re keeping, then fold the others into it here.</div>
      <div class="ractions">
        <button class="btn ghost2 rprev" data-g="${i}" disabled>Preview merge</button>
        <button class="btn rgo" data-g="${i}" disabled>Merge into kept profile</button>
        <select class="rwin" data-g="${i}" hidden title="Both profiles accepted a duty \u2014 choose whose area and call history survives">
          <option value="">Whose work survives?\u2026</option>
          <option value="survivor">The profile I\u2019m keeping</option>
          <option value="loser">The other profile</option>
        </select>
      </div>
      <div class="rout" id="rout-${i}"></div>
    </div>
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
