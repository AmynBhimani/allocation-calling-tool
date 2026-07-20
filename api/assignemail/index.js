// Acceptance email ("you've been assigned"). Sent per session to ALL accepted volunteers whose Jamatkhana
// puts them in that session, with their area, the session's check-in window, their region's orientation
// day, and a personal decline link (backed by api/decline). Independent of the duty email — its own
// accepted_notified_at stamp, so neither blocks the other.
//   GET no session -> the session list; ?session=ID -> preview (counts + a rendered sample).
//   POST { session, mode:"test", testTo } -> one real send to yourself. { session, mode:"send" } -> a
//   batch of up to 500: generate/keep each person's decline_token, send, then stamp accepted_notified_at.
// Super Admin / Admin only (Admin region-walled). Sends via the daily-digest ACS sender.
const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor, readSessions } = require("../shared/store");
const { buildJkIndex } = require("../shared/sessions");
const { sendWithBudget } = require("../shared/dutyemail");
const { selectAcceptedForSession, renderAssignEmail, stampAcceptedSent, checkInFor, orientationFor, newToken } = require("../shared/wrapemail");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const PREVIEW_CAP = 500, BATCH_MAX = 500, SEND_BUDGET_MS = 35000, SEND_CONCURRENCY = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPLY_TO = "volunteer.experience@iicanada.net";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const emailOf = (p) => (p && p.userDetails ? String(p.userDetails).toLowerCase() : null);

function baseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const h = req.headers || {};
  const host = String(h["x-forwarded-host"] || h["host"] || "").trim();
  const proto = String(h["x-forwarded-proto"] || "https").trim();
  return host ? proto + "://" + host : "";
}
const declineUrlFor = (base, region, uid, token) =>
  base + "/decline.html?u=" + encodeURIComponent(uid) + "&r=" + encodeURIComponent(region) + "&t=" + encodeURIComponent(token);

module.exports = async function (context, req) {
  try {
    const p = getPrincipal(req);
    const roles = (p && p.userRoles) || [];
    const email = emailOf(p);
    const isSuper = roles.includes("superadmin");
    if (!(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const isPost = String(req.method || "").toUpperCase() === "POST";
    const sessions = await readSessions(null);
    const jkIndex = buildJkIndex(sessions);

    const want = String(((isPost ? (req.body && req.body.session) : (req.query && req.query.session)) || "")).trim();
    if (!want) {
      if (isPost) { context.res = { status: 400, body: { error: "No session specified." } }; return; }
      context.res = { body: { sessions: sessions.map(s => ({ id: String(s.id), name: s.name })) } }; return;
    }
    const session = sessions.find(s => String(s.id) === want);
    if (!session) { context.res = { status: 404, body: { error: "Unknown session." } }; return; }
    const checkIn = checkInFor(session.name);

    let regions = REGIONS.slice();
    if (!isSuper) { const allowed = allowedRegionsFor(await readRolesStore(), email) || []; regions = regions.filter(r => allowed.includes(r)); }
    const container = await getContainer(DATA_CONTAINER);
    const base = baseUrl(req);

    const gather = async () => {
      const eligible = [], noEmail = [];
      const counts = { eligible: 0, noEmail: 0, alreadySent: 0, noSession: 0 };
      for (const region of regions) {
        const { records } = await readRegion(container, region);
        const sel = selectAcceptedForSession(records, want, jkIndex);
        counts.eligible += sel.eligible.length; counts.noEmail += sel.noEmail.length;
        counts.alreadySent += sel.alreadySent; counts.noSession += sel.noSession;
        for (const e of sel.eligible) eligible.push(e);
        for (const e of sel.noEmail) noEmail.push(e);
      }
      return { eligible, noEmail, counts };
    };
    const sampleFor = (r) => renderAssignEmail({
      first: r ? r.first : "Volunteer", area: r ? r.area : "(your area)",
      checkIn: checkIn || "(check-in time)", orientation: r ? orientationFor(r.region) : "(orientation day)",
      declineUrl: base ? declineUrlFor(base, (r ? r.region : "Prairies"), (r ? r.user_id : "sample"), "sample-token") : "(decline link \u2014 site URL not resolved)",
    });

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
        // No population scan for a test — render a sample (session check-in + placeholder area/decline)
        // and send one. The preview pane already shows a real recipient.
        const msg = sampleFor(null);
        await sendMail(to, msg);
        context.res = { body: { ok: true, testSentTo: to, subject: msg.subject } };
        return;
      }

      if (mode === "send") {
        if (!base) { context.res = { status: 500, body: { error: "Couldn't determine the site URL for the decline link. Set a PUBLIC_BASE_URL app setting and retry." } }; return; }
        const { eligible } = await gather();
        const total = eligible.length;
        const batch = eligible.slice(0, BATCH_MAX);
        const tokenOf = new Map();
        for (const r of batch) tokenOf.set(String(r.user_id), r.decline_token || newToken());
        const res = await sendWithBudget(batch, (r) => sendMail(r.email, renderAssignEmail({
          first: r.first, area: r.area, checkIn, orientation: orientationFor(r.region),
          declineUrl: declineUrlFor(base, r.region, r.user_id, tokenOf.get(String(r.user_id))),
        })), { concurrency: SEND_CONCURRENCY, budgetMs: SEND_BUDGET_MS });

        // Stamp the sent recipients per region: accepted_notified_at + persist the decline_token used.
        const nowIso = new Date().toISOString();
        const sentSet = new Set(res.sent);
        const sentByRegion = {};
        for (const r of batch) { const uid = String(r.user_id); if (sentSet.has(uid)) (sentByRegion[r.region] = sentByRegion[r.region] || new Map()).set(uid, tokenOf.get(uid)); }
        const stampFailures = [];
        for (const region of Object.keys(sentByRegion)) {
          try { await mergeRegion(container, region, (records) => stampAcceptedSent(records, sentByRegion[region], nowIso)); }
          catch (e) { stampFailures.push({ region, error: String((e && e.message) || e) }); }
        }
        context.res = { body: {
          ok: true, session: { id: String(session.id), name: session.name },
          attempted: batch.length, sent: res.sent.length, failed: res.failed.length,
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
    const sample = sampleFor(eligible[0] || null);
    context.res = { body: {
      session: { id: String(session.id), name: session.name }, checkIn, counts,
      capped: eligible.length > PREVIEW_CAP,
      eligible: eligible.slice(0, PREVIEW_CAP).map(e => ({ user_id: e.user_id, name: e.name, region: e.region, area: e.area, email: e.email, orientation: orientationFor(e.region) })),
      noEmail: noEmail.map(e => ({ user_id: e.user_id, name: e.name, region: e.region, area: e.area })),
      sample,
    } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
