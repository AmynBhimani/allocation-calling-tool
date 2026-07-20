// Duty confirmation emails.
//
// GET  (read-only dry run):
//   no session   -> the list of sessions for the picker
//   ?session=ID  -> who WOULD be emailed for it (on the iVol lineup or entered, with an email, not yet
//                   notified), who is on the lineup but has no address (phone them), how many were
//                   already emailed, and a rendered SAMPLE. Writes and sends nothing.
// POST (actions, body { session, mode, ... }):
//   mode "test"  -> send ONE real message to body.testTo so a real inbox delivery can be verified.
//                   Renders a real eligible recipient when there is one. Stamps nobody.
//   mode "send"  -> send to up to BATCH_MAX eligible for the session, in parallel under a wall-clock
//                   budget so a large batch can't hit the function timeout. On each ACS acceptance the
//                   recipient's notified_at is stamped (ONE safe merge-write per region) so a re-run
//                   never double-emails. Failed sends are left un-stamped and reported, so the next
//                   click retries only them; if more remain than one click covers, the response says so.
//
// Sender is the managed azurecomm domain (the daily digest's ACS connection + from address); Reply-To
// points at the Volunteer Experience mailbox as a safety net even though the copy says not to reply.
// Selection + rendering + the send/stamp helpers live in shared/dutyemail (pure, unit-tested). Super
// Admin and Admin only (Admin region-walled).
const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor, readSessions, readConfigJson } = require("../shared/store");
const { buildLookups, selectForSession, renderDutyEmail, sendWithBudget, stampNotified, REPLY_TO, ON_LINEUP, hasEmail } = require("../shared/dutyemail");

const ROSTER_BLOB = "session-duties.json";
const DUTIES_BLOB = "duties.json";
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const PREVIEW_CAP = 500;          // eligible rows returned in the preview (counts are exact regardless)
const BATCH_MAX = 500;            // most recipients one Send click will attempt
const SEND_BUDGET_MS = 35000;     // stop before the function-host timeout and report the remainder
const SEND_CONCURRENCY = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const emailOf = (p) => {
  if (!p) return null;
  let e = p.userDetails || null;
  if (!e && Array.isArray(p.claims)) {
    const c = p.claims.find(c => /(emailaddress|email|preferred_username|upn)$/i.test(c.typ || c.type || ""));
    if (c) e = c.val || c.value;
  }
  return e ? String(e).toLowerCase() : null;
};

const _clean = (s) => String(s == null ? "" : s).trim();
const _csvCell = (v) => { v = String(v == null ? "" : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const _toCsv = (headers, rows) => "\ufeff" + [headers.map(_csvCell).join(","), ...rows.map(r => r.map(_csvCell).join(","))].join("\r\n");

module.exports = async function (context, req) {
  try {
    const p = getPrincipal(req);
    const roles = (p && p.userRoles) || [];
    const email = emailOf(p);
    const isSuper = roles.includes("superadmin");
    const isAdmin = roles.includes("admin");
    if (!(isSuper || isAdmin)) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const isPost = String(req.method || "").toUpperCase() === "POST";
    const sessions = await readSessions(null);

    // All-sessions duty progress tally for the screen header: across every session, how many duty
    // emails have been sent (lineup rows stamped notified_at) vs. still to send. No catalog lookup, no ACS.
    if (!isPost && String((req.query && req.query.summary) || "") === "1") {
      let sRegions = REGIONS.slice();
      if (!isSuper) { const allowed = allowedRegionsFor(await readRolesStore(), email) || []; sRegions = sRegions.filter(r => allowed.includes(r)); }
      const sContainer = await getContainer(DATA_CONTAINER);
      let sent = 0, remaining = 0, noEmail = 0;
      for (const region of sRegions) {
        const { records } = await readRegion(sContainer, region);
        const seen = new Set();
        for (const v of records) {
          const uid = String(v.user_id);
          if (seen.has(uid)) continue; seen.add(uid);
          const rows = (v.event_assignments || []).filter(r => r && r.basis === "session" && ON_LINEUP.has(_clean(r.state)));
          if (!rows.length) continue;
          const hasEm = hasEmail(v);
          for (const r of rows) { if (!hasEm) { noEmail++; } else if (r.notified_at) { sent++; } else { remaining++; } }
        }
      }
      context.res = { body: { summary: { sent, remaining, noEmail } } };
      return;
    }

    const want = String(((isPost ? (req.body && req.body.session) : (req.query && req.query.session)) || "")).trim();
    if (!want) {
      if (isPost) { context.res = { status: 400, body: { error: "No session specified." } }; return; }
      context.res = { body: { sessions: sessions.map(s => ({ id: String(s.id), name: s.name })) } }; return;
    }
    const session = sessions.find(s => String(s.id) === want);
    if (!session) { context.res = { status: 404, body: { error: "Unknown session." } }; return; }

    // Region scope: superadmin sees all; admin is walled to their event regions.
    let regions = REGIONS.slice();
    if (!isSuper) {
      const allowed = allowedRegionsFor(await readRolesStore(), email) || [];
      regions = regions.filter(r => allowed.includes(r));
    }

    const container = await getContainer(DATA_CONTAINER);
    const lookups = buildLookups(sessions, await readConfigJson(ROSTER_BLOB), await readConfigJson(DUTIES_BLOB));

    // Gather this session's eligible / no-email across the in-scope regions.
    const gather = async () => {
      const eligible = [], noEmail = [];
      const counts = { eligible: 0, noEmail: 0, alreadySent: 0, onLineup: 0 };
      for (const region of regions) {
        const { records } = await readRegion(container, region);
        const sel = selectForSession(records, want, lookups);
        counts.eligible += sel.eligible.length; counts.noEmail += sel.noEmail.length;
        counts.alreadySent += sel.alreadySent; counts.onLineup += sel.onLineup;
        for (const e of sel.eligible) eligible.push(e);
        for (const e of sel.noEmail) noEmail.push(e);
      }
      return { eligible, noEmail, counts };
    };

    // ---- POST: export / marksent / test / send ----
    if (isPost) {
      const mode = String((req.body && req.body.mode) || "").trim();

      // CSV export of this session's duty recipients for external mail-merge (e.g. SendGrid). No ACS.
      if (mode === "export") {
        const { eligible } = await gather();
        const rows = eligible.map(e => [_clean(e.email), (_clean(e.name) || "Volunteer"), _clean(e.sessionName),
          _clean(e.area), _clean(e.dutyName), _clean(e.description), _clean(e.checkIn)]);
        const csv = _toCsv(["email", "first_name", "session", "area", "duty", "duty_description", "check_in"], rows);
        context.res = { body: { ok: true, csv, filename: "duty-recipients-" + want + ".csv", count: rows.length, session: { id: String(session.id), name: session.name } } };
        return;
      }

      // Mark this session's eligible recipients as sent (stamp notified_at) after an external send. No ACS.
      // Retry-safe: re-gathers eligible inside the merge closure and captures the count from the last run.
      if (mode === "marksent") {
        const nowIso = new Date().toISOString();
        let marked = 0;
        for (const region of regions) {
          let n = 0;
          await mergeRegion(container, region, (records) => {
            const { eligible } = selectForSession(records, want, lookups);
            const uids = new Set(eligible.map(e => String(e.user_id)));
            stampNotified(records, uids, want, nowIso);
            n = uids.size;
            return records;
          });
          marked += n;
        }
        context.res = { body: { ok: true, marked, session: { id: String(session.id), name: session.name } } };
        return;
      }

      const conn = process.env.ACS_EMAIL_CONNECTION_STRING, from = process.env.DASHBOARD_EMAIL_FROM;
      if (!conn || !from) { context.res = { status: 500, body: { error: "Email not configured (need ACS_EMAIL_CONNECTION_STRING and DASHBOARD_EMAIL_FROM)." } }; return; }
      let EmailClient;
      try { ({ EmailClient } = require("@azure/communication-email")); }
      catch { context.res = { status: 500, body: { error: "@azure/communication-email is not installed in the API." } }; return; }
      const client = new EmailClient(conn);
      // Resolves on ACS acceptance = success; deliberately NOT polled to completion so a full batch
      // stays within the wall-clock budget. Reply-To is the VE mailbox as a stray-reply safety net.
      const sendMail = (toAddress, msg) => client.beginSend({
        senderAddress: from,
        content: { subject: msg.subject, plainText: msg.text, html: msg.html },
        recipients: { to: [{ address: toAddress }] },
        replyTo: [{ address: REPLY_TO }],
      });

      if (mode === "test") {
        const to = String((req.body && req.body.testTo) || "").trim();
        if (!EMAIL_RE.test(to)) { context.res = { status: 400, body: { error: "Enter a valid test email address." } }; return; }
        const { eligible } = await gather();
        const msg = renderDutyEmail(eligible[0] || {
          name: "Volunteer", sessionName: session.name, dutyName: "(sample duty)",
          description: "(sample duty description)", checkIn: "(sample check-in time)",
        });
        await sendMail(to, msg);
        context.res = { body: { ok: true, testSentTo: to, subject: msg.subject, usedRealRecipient: !!eligible[0] } };
        return;
      }

      if (mode === "send") {
        const { eligible } = await gather();
        const totalEligible = eligible.length;
        const batch = eligible.slice(0, BATCH_MAX);
        const res = await sendWithBudget(batch, (r) => sendMail(r.email, renderDutyEmail(r)),
          { concurrency: SEND_CONCURRENCY, budgetMs: SEND_BUDGET_MS });
        // Stamp the ACS-accepted recipients: one safe merge-write per region that had any (mergeRegion
        // re-reads on conflict, so concurrent lineup edits are never clobbered).
        const sentSet = new Set(res.sent); const nowIso = new Date().toISOString();
        const regionsWithSends = new Set(batch.filter(r => sentSet.has(String(r.user_id))).map(r => r.region));
        const stampFailures = [];
        for (const region of regionsWithSends) {
          try { await mergeRegion(container, region, (records) => stampNotified(records, sentSet, want, nowIso)); }
          catch (e) { stampFailures.push({ region, error: String((e && e.message) || e) }); }
        }
        context.res = { body: {
          ok: true, session: { id: String(session.id), name: session.name },
          attempted: batch.length, sent: res.sent.length, failed: res.failed.length,
          remaining: Math.max(0, totalEligible - res.sent.length), stoppedEarly: res.stopped,
          failures: res.failed.slice(0, 100),
          stampWriteFailed: stampFailures.length ? stampFailures : undefined,
        } };
        return;
      }

      context.res = { status: 400, body: { error: "Unknown action." } };
      return;
    }

    // ---- GET preview ----
    const { eligible, noEmail, counts } = await gather();
    const sample = renderDutyEmail(eligible[0] || {
      name: "Volunteer", sessionName: session.name, dutyName: "(duty)",
      description: "(duty description)", checkIn: "(check-in time)",
    });
    context.res = { body: {
      session: { id: String(session.id), name: session.name },
      counts, capped: eligible.length > PREVIEW_CAP,
      eligible: eligible.slice(0, PREVIEW_CAP).map(e => ({ user_id: e.user_id, name: e.name, region: e.region, area: e.area, dutyName: e.dutyName, checkIn: e.checkIn, isLead: e.isLead, email: e.email })),
      noEmail: noEmail.map(e => ({ user_id: e.user_id, name: e.name, region: e.region, area: e.area, dutyName: e.dutyName })),
      sample,
    } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
