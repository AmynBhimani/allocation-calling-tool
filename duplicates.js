// Read-only view for the internal duplicate scan (Build A2). Fetches /api/dedupscan and renders the
// clusters, most urgent first. No actions here — resolution is the separate screen (Build B).
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
    const fresh = BI_STATUS.ageMinutes != null && BI_STATUS.ageMinutes <= 120;
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
}

// A stable per-cluster key so we can find its DOM + default survivor.
function defaultSurvivor(c) {
  // Most progress wins: accepted/confirmed > called > assigned > untouched. Ties -> a numeric (BI) id
  // over a write-in (so the surviving record is a real BI account where possible).
  const rank = (m) => (m.accepted ? 4 : 0) + (m.call_outcome ? 2 : 0) + (m.assigned_caller ? 1 : 0) + (m.is_writein ? 0 : 0.5);
  return c.members.slice().sort((a, b) => rank(b) - rank(a))[0].user_id;
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

  // Groups with 2+ BI accounts that are both live must go to the BI team — the resolve endpoint will
  // refuse, but we hint here too. We can't know liveness client-side without the snapshot, so we show
  // the action and let the server decide; needs_bi_check gets a gentle nudge.
  const needsBi = c.numericIdCount >= 2;
  const actions = `<div class="cactions">
    <button class="btn-resolve" data-cl="${i}">Keep selected · merge the rest</button>
    <button class="btn-ghost" data-cl="${i}" data-act="preview">Preview</button>
    ${needsBi ? `<span class="setaside">2 BI accounts — needs a fresh BI snapshot; if both are live it goes to the BI team.</span>` : ""}
    <span class="hint">Pick the row to keep, then merge.</span>
    <div class="resolvemsg" id="msg-${i}" style="display:none"></div>
  </div>`;

  return `<div class="cluster ${cls === "danger" ? "danger" : ""}" id="cl-${i}">
    <div class="chead">${badges}<span class="why">${why ? "matched on " + esc(why) : ""}</span></div>
    <table class="dtable">
      <thead><tr><th></th><th>Account ID</th><th>Name</th><th>Age</th><th>Jamatkhana</th><th>Area</th><th>Status</th><th>Caller</th><th>Contact</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
  root.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener("change", () => {
    root.querySelectorAll(".rowpick").forEach(tr => tr.classList.toggle("survivor", tr.dataset.id === r.value));
  }));
  root.querySelector(".btn-resolve").addEventListener("click", () => doResolve(i, true));
  root.querySelector('[data-act="preview"]').addEventListener("click", () => doResolve(i, false));
}

function selectedSurvivor(i) {
  const r = document.querySelector(`input[name="surv-${i}"]:checked`);
  return r ? r.value : null;
}

async function doResolve(i, commit) {
  const c = window.__clusters[i];
  const survivorId = selectedSurvivor(i);
  const msg = document.getElementById("msg-" + i);
  const show = (cls, text) => { msg.style.display = "block"; msg.className = "resolvemsg " + cls; msg.innerHTML = text; };
  if (!survivorId) { show("err", "Pick a row to keep first."); return; }
  const loserIds = c.members.map(m => String(m.user_id)).filter(id => id !== String(survivorId));

  // Always dry-run first.
  show("ok", "Checking…");
  let dry;
  try {
    dry = await (await fetch("/api/dedupresolve", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: c.region, survivorId, loserIds }) })).json();
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
  if (bothInBi) summary += ` ${refused.filter(r => r.bothInBi).length} can't merge — both are live in Better Impact (resolve those in BI, then re-scan).`;
  const needsWinner = refused.some(r => r.needsWinner);
  if (needsWinner) { show("err", summary + " Two records are both Accepted — that needs a manual winner choice (coming in the next step). Skipping for now."); return; }

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
      body: JSON.stringify({ region: c.region, survivorId, loserIds, commit: true, backedUp: true }) })).json();
  } catch (e) { show("err", "Merge failed: " + esc(e.message)); return; }
  if (res.error) { show("err", esc(res.error)); return; }

  show("ok", `Done — merged ${res.merged} record(s) into ${esc(String(survivorId))}.${res.refused ? " " + res.refused + " left for the BI team." : ""} Re-scanning…`);
  // collapse this cluster and refresh counts after a moment
  const root = document.getElementById("cl-" + i);
  if (root) { root.style.opacity = "0.5"; root.querySelectorAll("button").forEach(b => b.disabled = true); }
  setTimeout(load, 1200);
}

boot();
