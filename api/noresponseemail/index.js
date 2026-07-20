// No-Response email. Goes to the mass-accept "unreached" cohort (caller logged No answer / Emailed /
// Thinking) — the generic "we couldn't reach you, email us if you're still interested" note. Sending
// stamps their single status "Sent No Response Email", which both groups them and prevents a re-send.
// Not session-scoped (the message carries no session detail).
//   GET  -> preview (counts + a rendered sample).
//   POST { mode:"test", testTo } -> one send to yourself. { mode:"send" } -> a batch of up to 500.
// Super Admin / Admin only (Admin region-walled). Sends via the daily-digest ACS sender.
const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { sendWithBudget } = require("../shared/dutyemail");
const { selectUnreached, renderNoResponseEmail, stampNoResponseSent } = require("../shared/wrapemail");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const PREVIEW_CAP = 500, BATCH_MAX = 500, SEND_BUDGET_MS = 35000, SEND_CONCURRENCY = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPLY_TO = "volunteer.experience@iicanada.net";
const clean = (s) => String(s == null ? "" : s).trim();
const csvCell = (v) => { v = String(v == null ? "" : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCsv = (headers, rows) => "\ufeff" + [headers.map(csvCell).join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\r\n");

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const emailOf = (p) => (p && p.userDetails ? String(p.userDetails).toLowerCase() : null);

module.exports = async function (context, req) {
  try {
    const p = getPrincipal(req);
    const roles = (p && p.userRoles) || [];
    const email = emailOf(p);
    const isSuper = roles.includes("superadmin");
    if (!(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const isPost = String(req.method || "").toUpperCase() === "POST";
    let regions = REGIONS.slice();
    if (!isSuper) { const allowed = allowedRegionsFor(await readRolesStore(), email) || []; regions = regions.filter(r => allowed.includes(r)); }
    const container = await getContainer(DATA_CONTAINER);

    const gather = async () => {
      const eligible = [], noEmail = [];
      const counts = { eligible: 0, noEmail: 0, alreadySent: 0 };
      for (const region of regions) {
        const { records } = await readRegion(container, region);
        const sel = selectUnreached(records);
        counts.eligible += sel.eligible.length; counts.noEmail += sel.noEmail.length; counts.alreadySent += sel.alreadySent;
        for (const e of sel.eligible) eligible.push(e);
        for (const e of sel.noEmail) noEmail.push(e);
      }
      return { eligible, noEmail, counts };
    };

    // CSV export of ALL unreached recipients for external mail-merge (e.g. SendGrid). Data-only, no ACS.
    if (isPost && String((req.body && req.body.mode) || "").trim() === "export") {
      const { eligible } = await gather();
      const rows = eligible.map(e => [clean(e.email), (clean(e.first) || "Volunteer"), clean(e.region)]);
      const csv = toCsv(["email", "first_name", "region"], rows);
      context.res = { body: { ok: true, csv, filename: "no-response-recipients.csv", count: rows.length } };
      return;
    }

    // ---- POST: test / send ----
    if (isPost) {
      const mode = String((req.body && req.body.mode) || "").trim();
      const conn = process.env.ACS_EMAIL_CONNECTION_STRING, from = process.env.DASHBOARD_EMAIL_FROM;
      if (!conn || !from) { context.res = { status: 500, body: { error: "Email not configured (need ACS_EMAIL_CONNECTION_STRING and DASHBOARD_EMAIL_FROM)." } }; return; }
      let EmailClient;
      try { ({ EmailClient } = require("@azure/communication-email")); }
      catch { context.res = { status: 500, body: { error: "@azure/communication-email is not installed in the API." } }; return; }
      const client = new EmailClient(conn);
      const sendMail = (to, msg) => client.beginSend({
        senderAddress: from, content: { subject: msg.subject, plainText: msg.text, html: msg.html },
        recipients: { to: [{ address: to }] }, replyTo: [{ address: REPLY_TO }],
      });

      if (mode === "test") {
        const to = String((req.body && req.body.testTo) || "").trim();
        if (!EMAIL_RE.test(to)) { context.res = { status: 400, body: { error: "Enter a valid test email address." } }; return; }
        const { eligible } = await gather();
        const msg = renderNoResponseEmail({ first: eligible[0] ? eligible[0].first : "Volunteer" });
        await sendMail(to, msg);
        context.res = { body: { ok: true, testSentTo: to, subject: msg.subject, usedRealRecipient: !!eligible[0] } };
        return;
      }

      if (mode === "send") {
        const { eligible } = await gather();
        const total = eligible.length;
        const batch = eligible.slice(0, BATCH_MAX);
        const res = await sendWithBudget(batch, (r) => sendMail(r.email, renderNoResponseEmail({ first: r.first })),
          { concurrency: SEND_CONCURRENCY, budgetMs: SEND_BUDGET_MS });
        const nowIso = new Date().toISOString();
        const sentSet = new Set(res.sent);
        const regionsWithSends = new Set(batch.filter(r => sentSet.has(String(r.user_id))).map(r => r.region));
        const stampFailures = [];
        for (const region of regionsWithSends) {
          try { await mergeRegion(container, region, (records) => stampNoResponseSent(records, sentSet, nowIso)); }
          catch (e) { stampFailures.push({ region, error: String((e && e.message) || e) }); }
        }
        context.res = { body: {
          ok: true, attempted: batch.length, sent: res.sent.length, failed: res.failed.length,
          remaining: Math.max(0, total - res.sent.length), stoppedEarly: res.stopped,
          failures: res.failed.slice(0, 100), stampWriteFailed: stampFailures.length ? stampFailures : undefined,
        } };
        return;
      }

      context.res = { status: 400, body: { error: "Unknown action." } };
      return;
    }

    // ---- GET preview ----
    const { eligible, noEmail, counts } = await gather();
    const sample = renderNoResponseEmail({ first: eligible[0] ? eligible[0].first : "Volunteer" });
    context.res = { body: {
      counts, capped: eligible.length > PREVIEW_CAP,
      eligible: eligible.slice(0, PREVIEW_CAP).map(e => ({ user_id: e.user_id, name: e.name, region: e.region, email: e.email })),
      noEmail: noEmail.map(e => ({ user_id: e.user_id, name: e.name, region: e.region })),
      sample,
    } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
