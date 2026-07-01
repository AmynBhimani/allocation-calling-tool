// Daily dashboard digest — a single email with one section per region.
// Triggered over HTTP by an external scheduler (Logic App Recurrence or a GitHub Actions cron),
// because Static Web App managed Functions don't support timer triggers. Self-gated by a shared
// secret (DIGEST_TRIGGER_KEY) since the caller is a machine with no Static Web App login.
//
// Required app settings:
//   DIGEST_TRIGGER_KEY            - shared secret the scheduler must present (header x-digest-key or ?key=)
//   ACS_EMAIL_CONNECTION_STRING   - Azure Communication Services connection string
//   DASHBOARD_EMAIL_FROM          - verified ACS sender, e.g. donotreply@<id>.azurecomm.net
//   DASHBOARD_EMAIL_TO            - one or more recipients, comma-separated
// Optional: ?dry=1 computes and returns the HTML WITHOUT sending (for testing).

const { getContainer, readRegion, REGIONS } = require("../shared/store");
const { rollupRecords, rowsFromByArea, rollupByJk, jkGrid } = require("../shared/rollup");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const COLS = [
  { key: "assignedDuty", label: "Assigned" },
  { key: "accepted", label: "Accepted" },
  { key: "callPending", label: "Call pending" },
  { key: "declined", label: "Declined" },
];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function regionTable(region, rows, totals) {
  const head = `<tr><th align="left">Area</th>` + COLS.map(c => `<th align="right">${c.label}</th>`).join("") + `</tr>`;
  const body = rows.map(r =>
    `<tr><td>${esc(r.area)}</td>` + COLS.map(c => `<td align="right">${r[c.key] || 0}</td>`).join("") + `</tr>`
  ).join("");
  const totalRow = `<tr style="font-weight:bold;border-top:2px solid #1f3a5f">` +
    `<td>Total</td>` + COLS.map(c => `<td align="right">${totals[c.key] || 0}</td>`).join("") + `</tr>`;
  const empty = rows.length ? "" : `<tr><td colspan="${COLS.length + 1}" style="color:#888">No volunteers in the callable pipeline yet.</td></tr>`;
  return `
    <h2 style="font-family:Georgia,serif;color:#1f3a5f;margin:26px 0 8px">${esc(region)}</h2>
    <table cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;font-size:14px">
      <thead style="background:#1f3a5f;color:#fff">${head}</thead>
      <tbody>${body}${empty}${totalRow}</tbody>
    </table>`;
}

async function buildDigest(container) {
  const grand = { byArea: {}, totals: { assignedDuty: 0, accepted: 0, callPending: 0, declined: 0 } };
  const jkAcc = { byJk: {}, areas: new Set() };
  const sections = [];
  for (const region of REGIONS) {
    const { records } = await readRegion(container, region);
    const { byArea, totals } = rollupRecords(records);   // fresh per-region tally
    rollupRecords(records, grand);                        // also fold into the grand total
    rollupByJk(records, jkAcc);                           // JK × area grid (all regions)
    sections.push(regionTable(region, rowsFromByArea(byArea), totals));
  }
  const g = grand.totals;
  // Date shown in the email, in Pacific time. Doesn't depend on any platform setting; override with
  // DIGEST_TIME_ZONE only if you ever want a different zone.
  const tz = process.env.DIGEST_TIME_ZONE || "America/Vancouver";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const summary = COLS.map(c => `${c.label}: <b>${g[c.key] || 0}</b>`).join(" &nbsp;•&nbsp; ");

  // JK × area allocation grid (all regions).
  const jkAreas = [...jkAcc.areas].sort();
  const jk = jkGrid(jkAcc.byJk, jkAreas);
  let jkSection = "";
  if (jk.rows.length) {
    const head = `<tr><th align="left">Ceremony Jamatkhana</th>${jkAreas.map(a => `<th align="right">${esc(a)}</th>`).join("")}<th align="right">Total</th></tr>`;
    const rows = jk.rows.map(r => `<tr><td>${esc(r.jk)}</td>${jkAreas.map(a => `<td align="right">${r.counts[a] || 0}</td>`).join("")}<td align="right"><b>${r.total}</b></td></tr>`).join("");
    const foot = `<tr style="font-weight:bold;border-top:2px solid #1f3a5f"><td>All Jamatkhanas</td>${jkAreas.map(a => `<td align="right">${jk.colTotals[a] || 0}</td>`).join("")}<td align="right">${jk.grand}</td></tr>`;
    jkSection = `
      <h2 style="font-family:Georgia,serif;color:#1f3a5f;margin:26px 0 8px">Allocations by Ceremony Jamatkhana</h2>
      <div style="overflow-x:auto"><table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">
        <thead style="background:#1f3a5f;color:#fff">${head}</thead><tbody>${rows}${foot}</tbody></table></div>`;
  }

  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.45">
    <h1 style="font-family:Georgia,serif;color:#1f3a5f;font-size:20px;margin:0 0 2px">Volunteer Allocation — Daily Digest</h1>
    <div style="color:#666;font-size:13px">${esc(today)}</div>
    <div style="margin:14px 0 4px;font-size:14px;background:#f4f7fb;border:1px solid #dce5f0;border-radius:8px;padding:10px 12px">
      <b>All regions</b> &nbsp;—&nbsp; ${summary}</div>
    ${sections.join("")}
    ${jkSection}
    <p style="color:#999;font-size:12px;margin-top:24px">Assigned = Stable with a duty · Accepted = confirmed / iVol-ready · Call pending = assigned to a caller, not yet completed · Declined = withdrew. Allocations-by-JK counts everyone holding an area. Generated automatically; reply-to is unmonitored.</p>
  </body></html>`;
  const subject = `Volunteer Digest — ${today} (All: ${g.assignedDuty} assigned, ${g.accepted} accepted, ${g.callPending} pending)`;
  return { html, subject, grand: g };
}

module.exports = async function (context, req) {
  try {
    // --- auth gate (shared secret; the scheduler is unauthenticated) ---
    const need = process.env.DIGEST_TRIGGER_KEY;
    if (!need) { context.res = { status: 500, body: { error: "DIGEST_TRIGGER_KEY is not configured." } }; return; }
    const got = req.headers["x-digest-key"] || (req.query && req.query.key) || "";
    if (got !== need) { context.res = { status: 401, body: { error: "Unauthorized." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const container = await getContainer(DATA_CONTAINER);
    const { html, subject, grand } = await buildDigest(container);

    const dry = String((req.query && req.query.dry) || "") === "1";
    if (dry) { context.res = { status: 200, headers: { "Content-Type": "text/html" }, body: html }; return; }

    const conn = process.env.ACS_EMAIL_CONNECTION_STRING;
    const from = process.env.DASHBOARD_EMAIL_FROM;
    const toList = String(process.env.DASHBOARD_EMAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!conn || !from || !toList.length) {
      context.res = { status: 500, body: { error: "Email not configured (need ACS_EMAIL_CONNECTION_STRING, DASHBOARD_EMAIL_FROM, DASHBOARD_EMAIL_TO)." } };
      return;
    }

    let EmailClient;
    try { ({ EmailClient } = require("@azure/communication-email")); }
    catch { context.res = { status: 500, body: { error: "@azure/communication-email is not installed in the API." } }; return; }

    const client = new EmailClient(conn);
    const poller = await client.beginSend({
      senderAddress: from,
      content: { subject, html },
      recipients: { to: toList.map(address => ({ address })) },
    });
    const result = await poller.pollUntilDone();

    context.res = { status: 200, body: { ok: true, sent: toList.length, status: result.status, id: result.id, totals: grand } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
