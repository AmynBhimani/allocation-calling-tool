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
};

async function boot() {
  try {
    const me = await (await fetch("/.auth/me")).json();
    const chip = document.getElementById("whoami");
    if (chip) chip.textContent = (me.clientPrincipal && me.clientPrincipal.userDetails) || "";
  } catch (e) {}

  // Populate region options once from a first scan (or leave "All").
  document.getElementById("refreshBtn").onclick = load;
  document.getElementById("regionSel").onchange = load;
  document.getElementById("catSel").onchange = load;
  document.getElementById("minSel").onchange = load;
  await load(true);
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
  host.innerHTML = clusters.map(clusterHtml).join("");
}

function clusterHtml(c) {
  const cls = CAT_CLASS[c.category] || "";
  const why = (c.signals || []).map(s => SIGNAL_LABEL[s] || s).join(", ");
  const badges =
    `<span class="badge ${cls}">${esc(CAT_LABEL[c.category] || c.category)}</span>` +
    `<span class="badge conf">${esc(c.topConfidence)} confidence</span>` +
    `<span class="badge reg">${esc(c.region || "")}</span>` +
    (c.acceptedInMultipleAreas ? `<span class="badge danger">double-counted</span>` : "") +
    (c.numericIdCount >= 2 ? `<span class="badge warn">${c.numericIdCount} BI accounts</span>` : "");

  const rows = c.members.map(m => {
    const idCls = m.is_writein ? "idcell wi" : "idcell";
    const areaCls = (c.acceptedInMultipleAreas && m.accepted) ? "diffarea" : "";
    const state = m.accepted ? '<span class="acc">Accepted</span>'
      : (m.call_outcome ? esc(m.call_outcome) : (m.assigned_caller ? "Assigned" : "—"));
    return `<tr>
      <td class="${idCls}">${esc(String(m.user_id))}${m.is_writein ? " (write-in)" : ""}</td>
      <td>${esc(m.name)}</td>
      <td>${esc(m.ceremony_jk || "—")}</td>
      <td class="${areaCls}">${esc(m.final_area || "—")}</td>
      <td>${state}</td>
      <td>${esc(m.assigned_caller || "—")}</td>
      <td class="muted">${esc(m.email || m.cell_phone || "—")}</td>
    </tr>`;
  }).join("");

  return `<div class="cluster ${cls === "danger" ? "danger" : ""}">
    <div class="chead">${badges}<span class="why">${why ? "matched on " + esc(why) : ""}</span></div>
    <table class="dtable">
      <thead><tr><th>Account ID</th><th>Name</th><th>Jamatkhana</th><th>Area</th><th>Status</th><th>Caller</th><th>Contact</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

boot();
