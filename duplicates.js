// Duplicate scan + resolution screen. Fetches /api/dedupscan, renders clusters (most urgent first),
// and resolves them via /api/dedupresolve. Two resolution paths:
//   - one cluster at a time (pick the survivor row, "Keep selected · merge the rest")
//   - a batch: tick several groups, set each survivor, "Merge selected groups" in one action
// Both-accepted conflicts: if two records in a group both Accepted a duty, one acceptance must win.
//   - same area  -> low-stakes, auto-kept (the survivor's, or the highest-progress accepted record)
//   - different areas -> the real double-count: an inline picker asks which duty the person serves,
//     and the batch deliberately SKIPS these (they need your explicit choice, never auto-picked).
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

const CAT_LABEL = {
  accepted_multi_area: "Accepted in 2+ areas",
  needs_bi_check: "Needs BI check",
  mergeable: "Mergeable",
};
const CAT_CLASS = { accepted_multi_area: "danger", needs_bi_check: "warn", mergeable: "ok" };
const SIGNAL_LABEL = {
  email: "same email", phone: "same phone",
  name_same_jk: "same name + JK", name_diff_jk: "same name, different JK",
  name_diff_jk_age_match: "same name + age, different JK",
};

// ---- pure decision helpers (no DOM; unit-tested via module.exports) ------------------------------
const acceptedMembers = (c) => (c.members || []).filter(m => m.accepted);
const hasDoubleAccept = (c) => acceptedMembers(c).length >= 2;
// The scan sets acceptedInMultipleAreas when accepted records span 2+ distinct final areas — the
// genuine cross-area double-count. Same-area double-accepts are not flagged here.
const isDiffAreaDoubleAccept = (c) => hasDoubleAccept(c) && !!c.acceptedInMultipleAreas;

// Default survivor (identity kept): most progress wins, ties prefer a real BI id over a write-in.
function defaultSurvivor(c) {
  const rank = (m) => (m.accepted ? 4 : 0) + (m.call_outcome ? 2 : 0) + (m.assigned_caller ? 1 : 0) + (m.is_writein ? 0 : 0.5);
  return String(c.members.slice().sort((a, b) => rank(b) - rank(a))[0].user_id);
}
// Default surviving acceptance: the survivor's own acceptance if it accepted, else the highest-progress
// accepted record. Only meaningful when 2+ accepted.
function defaultAcceptanceId(c, survivorId) {
  const acc = acceptedMembers(c);
  if (!acc.length) return null;
  if (acc.some(m => String(m.user_id) === String(survivorId))) return String(survivorId);
  const rank = (m) => (m.call_outcome ? 2 : 0) + (m.assigned_caller ? 1 : 0) + (m.is_writein ? 0 : 0.5);
  return String(acc.slice().sort((a, b) => rank(b) - rank(a))[0].user_id);
}
// The keepAcceptanceOf value to send: null when no winner is needed; the operator's explicit pick for a
// different-area conflict; the auto default for a same-area double-accept.
function computeKeepAcceptance(c, survivorId, chosenAcceptanceId) {
  if (!hasDoubleAccept(c)) return null;
  if (isDiffAreaDoubleAccept(c)) return chosenAcceptanceId || defaultAcceptanceId(c, survivorId);
  return defaultAcceptanceId(c, survivorId);
}

async function boot() {
  try {
    const me = await (await fetch("/.auth/me")).json();
    const chip = document.getElementById("whoami");
    if (chip) chip.textContent = (me.clientPrincipal && me.clientPrincipal.userDetails) || "";
    window.__isSuper = ((me.clientPrincipal && me.clientPrincipal.userRoles) || []).includes("superadmin");
  } catch (e) {}

  document.getElementById("refreshBtn").onclick = load;
  document.getElementById("regionSel").onchange = load;
  document.getElementById("catSel").onchange = load;
  document.getElementById("minSel").onchange = load;
  document.getElementById("biRefresh").onclick = refreshBiSnapshot;
  await refreshBiStatus();
  await load(true);
}

// ---- BI snapshot (needed for the both-in-BI safety check) ----
let BI_STATUS = { present: false };
function biFresh() { return !!(BI_STATUS.present && BI_STATUS.ageMinutes != null && BI_STATUS.ageMinutes <= 120); }
async function refreshBiStatus() {
  const dot = document.getElementById("biDot"), status = document.getElementById("biStatus");
  const btn = document.getElementById("biRefresh");
  if (!window.__isSuper) {
    document.getElementById("bibar").style.display = "none"; return;
  }
  try {
    BI_STATUS = await (await fetch("/api/biidset")).json();
  } catch (e) { BI_STATUS = { present: false }; }
  if (!BI_STATUS.present) {
    dot.className = "dot none"; status.textContent = "No Better Impact snapshot yet — refresh before resolving groups with two BI accounts.";
  } else {
    const fresh = biFresh();
    dot.className = "dot " + (fresh ? "fresh" : "stale");
    status.textContent = `Better Impact snapshot: ${BI_STATUS.count} accounts, ${BI_STATUS.ageMinutes} min old${fresh ? "" : " (stale — refresh to resolve BI-vs-BI groups)"}.`;
  }
  btn.textContent = "Refresh BI snapshot";
}
async function refreshBiSnapshot() {
  const btn = document.getElementById("biRefresh");
  btn.disabled = true; btn.textContent = "Pulling Better Impact… (this can take a minute)";
  try {
    const r = await fetch("/api/biidset", { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
  } catch (e) { alert("Could not refresh BI snapshot: " + e.message); }
  btn.disabled = false;
  await refreshBiStatus();
  await load();   // re-render so resolve buttons re-enable
}

async function load(firstTime) {
  const region = document.getElementById("regionSel").value;
  const category = document.getElementById("catSel").value;
  const min = document.getElementById("minSel").value;
  const params = new URLSearchParams();
  if (region) params.set("region", region);
  if (category) params.set("category", category);
  if (min) params.set("min", min);

  document.getElementById("clusters").innerHTML = '<div class="loading">Scanning…</div>';
  document.getElementById("summary").innerHTML = "";
  BATCH.clear(); renderBatchBar();
  let data;
  try {
    const r = await fetch("/api/dedupscan?" + params.toString());
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || ("HTTP " + r.status)); }
    data = await r.json();
  } catch (err) {
    document.getElementById("clusters").innerHTML = `<div class="loading">Could not run the scan: ${esc(err.message)}</div>`;
    return;
  }

  // First time: fill the region dropdown with the regions we're allowed to see.
  if (firstTime === true) {
    const sel = document.getElementById("regionSel");
    (data.regions || []).forEach(rg => {
      const o = document.createElement("option"); o.value = rg; o.textContent = rg; sel.appendChild(o);
    });
  }

  renderSummary(data.stats);
  document.getElementById("scanInfo").textContent =
    `${data.stats.scanned} records scanned across ${(data.regions || []).length} region(s)`;
  renderClusters(data.clusters || []);
}

function sbox(n, label, cls) { return `<div class="sbox ${cls || ""}"><div class="n">${n}</div><div class="l">${label}</div></div>`; }

function renderSummary(s) {
  document.getElementById("summary").innerHTML =
    sbox(s.clusters, "duplicate groups", s.clusters ? "" : "ok") +
    sbox(s.accepted_multi_area, "accepted in 2+ areas", s.accepted_multi_area ? "danger" : "ok") +
    sbox(s.needs_bi_check, "need BI check", s.needs_bi_check ? "warn" : "") +
    sbox(s.mergeable, "mergeable", "ok") +
    sbox(s.duplicateRecords, "records involved", "");
}

function renderClusters(clusters) {
  const host = document.getElementById("clusters");
  if (!clusters.length) {
    host.innerHTML = `<div class="loading">No duplicate groups match the current filters. 🎉</div>`;
    return;
  }
  window.__clusters = clusters;   // keep for resolve actions
  host.innerHTML = clusters.map((c, i) => clusterHtml(c, i)).join("");
  clusters.forEach((c, i) => wireCluster(c, i));
  renderBatchBar();
}

function clusterHtml(c, i) {
  const cls = CAT_CLASS[c.category] || "";
  const why = (c.signals || []).map(s => SIGNAL_LABEL[s] || s).join(", ");
  const badges =
    `<span class="badge ${cls}">${esc(CAT_LABEL[c.category] || c.category)}</span>` +
    `<span class="badge conf">${esc(c.topConfidence)} confidence</span>` +
    `<span class="badge reg">${esc(c.region || "")}</span>` +
    (c.acceptedInMultipleAreas ? `<span class="badge danger">double-counted</span>` : "") +
    (c.numericIdCount >= 2 ? `<span class="badge warn">${c.numericIdCount} BI accounts</span>` : "");

  const surv = defaultSurvivor(c);
  const rows = c.members.map(m => {
    const idCls = m.is_writein ? "idcell wi" : "idcell";
    const areaCls = (c.acceptedInMultipleAreas && m.accepted) ? "diffarea" : "";
    const state = m.accepted ? '<span class="acc">Accepted</span>'
      : (m.call_outcome ? esc(m.call_outcome) : (m.assigned_caller ? "Assigned" : "—"));
    const isSurv = String(m.user_id) === String(surv);
    return `<tr class="rowpick${isSurv ? " survivor" : ""}" data-cl="${i}" data-id="${esc(String(m.user_id))}">
      <td><input type="radio" name="surv-${i}" value="${esc(String(m.user_id))}"${isSurv ? " checked" : ""}></td>
      <td class="${idCls}">${esc(String(m.user_id))}${m.is_writein ? " (write-in)" : ""}</td>
      <td>${esc(m.name)}</td>
      <td>${m.age == null ? "—" : m.age}</td>
      <td>${esc(m.ceremony_jk || "—")}</td>
      <td class="${areaCls}">${esc(m.final_area || "—")}</td>
      <td>${state}</td>
      <td>${esc(m.assigned_caller || "—")}</td>
      <td class="muted">${esc(m.email || m.cell_phone || "—")}</td>
    </tr>`;
  }).join("");

  // Different-area double-accept: inline "which duty stands" picker over the accepted records.
  let keepPick = "";
  if (isDiffAreaDoubleAccept(c)) {
    const def = defaultAcceptanceId(c, surv);
    const opts = acceptedMembers(c).map(m => {
      const id = String(m.user_id);
      const caller = m.assigned_caller ? ` · called by ${esc(m.assigned_caller)}` : "";
      return `<label class="kp-opt">
        <input type="radio" name="keep-${i}" value="${esc(id)}"${id === def ? " checked" : ""}>
        <b>${esc(m.final_area || "(no area)")}</b><span class="kp-meta">${esc(m.name)}${caller}</span>
      </label>`;
    }).join("");
    keepPick = `<div class="keeppick" id="keep-${i}">
      <div class="kp-title">⚑ Accepted in 2+ areas — which duty does this person actually serve?</div>
      <div class="kp-opts">${opts}</div>
      <div class="kp-note">The other accepted duty(ies) are released and recorded in the merge log; the losing area's QB can re-fill.</div>
    </div>`;
  }

  const needsBi = c.numericIdCount >= 2;
  const actions = `<div class="cactions">
    <button class="btn-resolve" data-cl="${i}">Keep selected · merge the rest</button>
    <button class="btn-ghost" data-cl="${i}" data-act="preview">Preview</button>
    ${needsBi ? `<span class="setaside">2 BI accounts — needs a fresh BI snapshot; if both are live it goes to the BI team.</span>` : ""}
    <span class="hint">Pick the row to keep, then merge.</span>
    <div class="resolvemsg" id="msg-${i}" style="display:none"></div>
  </div>`;

  return `<div class="cluster ${cls === "danger" ? "danger" : ""}" id="cl-${i}">
    <div class="chead">
      <label class="pickbatch" title="Include in a batch merge"><input type="checkbox" class="batchchk" data-cl="${i}"><span>batch</span></label>
      ${badges}<span class="why">${why ? "matched on " + esc(why) : ""}</span>
    </div>
    <table class="dtable">
      <thead><tr><th></th><th>Account ID</th><th>Name</th><th>Age</th><th>Jamatkhana</th><th>Area</th><th>Status</th><th>Caller</th><th>Contact</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${keepPick}
    ${actions}
  </div>`;
}

function wireCluster(c, i) {
  const root = document.getElementById("cl-" + i);
  if (!root) return;
  // radio + row click select the survivor
  root.querySelectorAll(".rowpick").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return;   // let the radio handle itself
      const radio = tr.querySelector('input[type=radio]'); if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
    });
  });
  root.querySelectorAll('input[name="surv-' + i + '"]').forEach(r => r.addEventListener("change", () => {
    root.querySelectorAll(".rowpick").forEach(tr => tr.classList.toggle("survivor", tr.dataset.id === r.value));
  }));
  root.querySelector(".btn-resolve").addEventListener("click", () => doResolve(i, true));
  root.querySelector('[data-act="preview"]').addEventListener("click", () => doResolve(i, false));
  const chk = root.querySelector(".batchchk");
  if (chk) chk.addEventListener("change", () => { if (chk.checked) BATCH.add(i); else BATCH.delete(i); renderBatchBar(); });
}

function selectedSurvivor(i) {
  const r = document.querySelector(`input[name="surv-${i}"]:checked`);
  return r ? r.value : null;
}
function selectedAcceptance(i) {
  const r = document.querySelector(`input[name="keep-${i}"]:checked`);
  return r ? r.value : null;
}

// Build the resolve payload for one cluster from the current UI selections. Shared by single + batch.
function resolvePayload(i) {
  const c = window.__clusters[i];
  const survivorId = selectedSurvivor(i) || defaultSurvivor(c);
  const loserIds = c.members.map(m => String(m.user_id)).filter(id => id !== String(survivorId));
  const keepAcceptanceOf = computeKeepAcceptance(c, survivorId, selectedAcceptance(i));
  const payload = { region: c.region, survivorId, loserIds };
  if (keepAcceptanceOf) payload.keepAcceptanceOf = keepAcceptanceOf;
  return payload;
}

async function doResolve(i, commit) {
  const c = window.__clusters[i];
  const msg = document.getElementById("msg-" + i);
  const show = (cls, text) => { msg.style.display = "block"; msg.className = "resolvemsg " + cls; msg.innerHTML = text; };
  if (!selectedSurvivor(i)) { show("err", "Pick a row to keep first."); return; }
  const base = resolvePayload(i);
  const survivorId = base.survivorId;

  // Always dry-run first.
  show("ok", "Checking…");
  let dry;
  try {
    dry = await (await fetch("/api/dedupresolve", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(base) })).json();
  } catch (e) { show("err", "Preview failed: " + esc(e.message)); return; }

  if (dry.need === "refresh_bi_idset") {
    show("err", "This group has two Better Impact accounts. Refresh the BI snapshot (button at top) first, then try again.");
    return;
  }
  if (dry.error) { show("err", esc(dry.error)); return; }

  const willMerge = (dry.results || []).filter(r => r.ok).length;
  const refused = (dry.results || []).filter(r => !r.ok);
  const bothInBi = refused.some(r => r.bothInBi);
  let summary = `Would keep ${esc(String(survivorId))} and merge ${willMerge} record(s).`;
  if (base.keepAcceptanceOf) summary += " " + consequenceLine(c, base.keepAcceptanceOf, dry);
  if (bothInBi) summary += ` ${refused.filter(r => r.bothInBi).length} can't merge — both are live in Better Impact (resolve those in BI, then re-scan).`;
  const needsWinner = refused.some(r => r.needsWinner);
  if (needsWinner) { show("err", summary + " Two records are both Accepted and no surviving duty was chosen — pick one above, then merge."); return; }

  if (!commit) { show("ok", summary); return; }
  if (willMerge === 0) { show("err", summary + " Nothing to merge."); return; }

  // Take a server-side backup, then commit.
  show("ok", "Taking a backup…");
  try {
    const b = await fetch("/api/backupSnapshot", { method: "POST" });
    if (!b.ok) { const e = await b.json().catch(() => ({})); throw new Error(e.error || ("backup HTTP " + b.status)); }
  } catch (e) { show("err", "Backup failed, nothing merged: " + esc(e.message)); return; }

  show("ok", "Merging…");
  let res;
  try {
    res = await (await fetch("/api/dedupresolve", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, commit: true, backedUp: true }) })).json();
  } catch (e) { show("err", "Merge failed: " + esc(e.message)); return; }
  if (res.error) { show("err", esc(res.error)); return; }

  show("ok", `Done — merged ${res.merged} record(s) into ${esc(String(survivorId))}.${res.refused ? " " + res.refused + " left for the BI team." : ""} Re-scanning…`);
  const root = document.getElementById("cl-" + i);
  if (root) { root.style.opacity = "0.5"; root.querySelectorAll("button").forEach(b => b.disabled = true); }
  setTimeout(load, 1200);
}

// Human-readable note about which accepted duties get released when a winner is chosen.
function consequenceLine(c, keepId, dry) {
  const kept = (c.members || []).find(m => String(m.user_id) === String(keepId));
  const keptArea = (kept && kept.final_area) || (dry && dry.survivorPreview && dry.survivorPreview.final_area) || "";
  const released = acceptedMembers(c)
    .filter(m => String(m.user_id) !== String(keepId) && (m.final_area || "") && lc(m.final_area) !== lc(keptArea))
    .map(m => `${m.final_area}${m.assigned_caller ? " (" + m.assigned_caller + ")" : ""}`);
  if (!released.length) return `Keeping the ${esc(keptArea || "chosen")} acceptance.`;
  return `Keeping the ${esc(keptArea || "chosen")} acceptance; releasing ${released.length} other accepted dut${released.length === 1 ? "y" : "ies"}: ${esc(released.join(", "))}.`;
}
const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();

// ---- Batch resolution -----------------------------------------------------------------------------
const BATCH = new Set();   // selected cluster indices for the current render

function renderBatchBar() {
  const bar = document.getElementById("batchbar");
  if (!bar) return;
  const n = BATCH.size;
  bar.innerHTML =
    `<span class="bb-count">${n} group${n === 1 ? "" : "s"} selected</span>` +
    `<button class="btn-resolve" id="bbMerge"${n ? "" : " disabled"}>Merge selected groups</button>` +
    `<button class="btn-ghost" id="bbAll">Select all shown</button>` +
    `<button class="btn-ghost" id="bbClear"${n ? "" : " disabled"}>Clear</button>` +
    `<div class="bb-msg" id="bbMsg" style="display:none"></div>`;
  const merge = document.getElementById("bbMerge"); if (merge) merge.onclick = armBatch;
  const all = document.getElementById("bbAll"); if (all) all.onclick = selectAllShown;
  const clear = document.getElementById("bbClear"); if (clear) clear.onclick = clearBatch;
}
function selectAllShown() {
  const cls = window.__clusters || [];
  cls.forEach((c, i) => BATCH.add(i));
  document.querySelectorAll(".batchchk").forEach(chk => { chk.checked = true; });
  renderBatchBar();
}
function clearBatch() {
  BATCH.clear();
  document.querySelectorAll(".batchchk").forEach(chk => { chk.checked = false; });
  renderBatchBar();
}

// Partition the current selection into what we'll merge vs. what we deliberately defer.
function partitionBatch() {
  const go = [], deferDiff = [], deferBi = [];
  for (const i of BATCH) {
    const c = window.__clusters[i];
    if (!c) continue;
    if (isDiffAreaDoubleAccept(c)) { deferDiff.push(i); continue; }   // needs an explicit winner choice
    if (c.numericIdCount >= 2 && !biFresh()) { deferBi.push(i); continue; }  // needs a fresh BI snapshot
    go.push(i);
  }
  return { go, deferDiff, deferBi };
}

function armBatch() {
  const bar = document.getElementById("batchbar");
  const { go, deferDiff, deferBi } = partitionBatch();
  const skipParts = [];
  if (deferDiff.length) skipParts.push(`${deferDiff.length} accepted in 2+ areas (pick the surviving duty individually)`);
  if (deferBi.length) skipParts.push(`${deferBi.length} need a fresh BI snapshot`);
  const skipNote = skipParts.length ? ` ${deferDiff.length + deferBi.length} will be skipped: ${skipParts.join("; ")}.` : "";
  if (!go.length) {
    bar.innerHTML = `<div class="bb-msg err" style="display:block">Nothing to merge in this selection.${skipNote} Resolve those individually.</div>` +
      `<button class="btn-ghost" id="bbBack">Back</button>`;
    document.getElementById("bbBack").onclick = renderBatchBar;
    return;
  }
  bar.innerHTML =
    `<span class="bb-count">Merge ${go.length} group${go.length === 1 ? "" : "s"} now?</span>` +
    `<span class="bb-note">A backup is taken first.${skipNote}</span>` +
    `<button class="btn-resolve" id="bbGo">Merge ${go.length} now</button>` +
    `<button class="btn-ghost" id="bbCancel">Cancel</button>` +
    `<div class="bb-msg" id="bbMsg" style="display:none"></div>`;
  document.getElementById("bbGo").onclick = () => runBatch(go, deferDiff.length + deferBi.length);
  document.getElementById("bbCancel").onclick = renderBatchBar;
}

async function runBatch(go, skippedCount) {
  const bar = document.getElementById("batchbar");
  const setMsg = (cls, html) => { bar.innerHTML = `<div class="bb-msg ${cls}" style="display:block">${html}</div>`; };
  setMsg("ok", "Taking one backup for the batch…");
  try {
    const b = await fetch("/api/backupSnapshot", { method: "POST" });
    if (!b.ok) { const e = await b.json().catch(() => ({})); throw new Error(e.error || ("backup HTTP " + b.status)); }
  } catch (e) { setMsg("err", "Backup failed — nothing merged. " + esc(e.message)); return; }

  let groupsMerged = 0, recordsMerged = 0, leftForBi = 0, failed = 0;
  for (let k = 0; k < go.length; k++) {
    const i = go[k];
    setMsg("ok", `Merging group ${k + 1} of ${go.length}…`);
    const payload = { ...resolvePayload(i), commit: true, backedUp: true };
    try {
      const r = await (await fetch("/api/dedupresolve", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload) })).json();
      if (r.error) { failed++; continue; }
      if (r.merged) { groupsMerged++; recordsMerged += r.merged; }
      if (r.refused) leftForBi += r.refused;
      // dim the merged cluster in place
      const root = document.getElementById("cl-" + i);
      if (root) { root.style.opacity = "0.5"; root.querySelectorAll("button,input").forEach(el => el.disabled = true); }
    } catch (e) { failed++; }
  }

  const bits = [`Merged ${groupsMerged} group${groupsMerged === 1 ? "" : "s"} (${recordsMerged} record${recordsMerged === 1 ? "" : "s"}).`];
  if (leftForBi) bits.push(`${leftForBi} fold${leftForBi === 1 ? "" : "s"} left for the BI team.`);
  if (skippedCount) bits.push(`${skippedCount} skipped — resolve individually.`);
  if (failed) bits.push(`${failed} group${failed === 1 ? "" : "s"} errored.`);
  setMsg(failed ? "err" : "ok", bits.join(" ") + " Re-scanning…");
  setTimeout(load, 1400);
}

// Only auto-boot in a browser; requiring this file in Node (for tests) exposes the pure helpers.
if (typeof document !== "undefined") boot();
if (typeof module !== "undefined" && module.exports) {
  module.exports = { acceptedMembers, hasDoubleAccept, isDiffAreaDoubleAccept, defaultSurvivor, defaultAcceptanceId, computeKeepAcceptance };
}
