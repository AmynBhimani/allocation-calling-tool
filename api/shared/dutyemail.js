// Duty confirmation emails — the DATA + TEMPLATE, kept pure and free of any storage, network, or
// sending. Selection of who gets an email and the exact rendered message are decided here so both can
// be tested precisely and shown in a dry-run BEFORE anything is sent. The endpoint (api/dutyemail)
// wires this to storage and, in a later step, to ACS for the actual send.
//
// WHO is emailable for a session mirrors the duty-review screen: a volunteer has AT MOST ONE session
// row (their Jamatkhana fixes their session), and they are emailable when that row is on the iVol
// lineup (submitted) or already assigned in iVol (entered), AND they have not been emailed for that
// row yet (notified_at unset), AND they have an email address.
//
// Check-in time and duty description are read from the SAME roster + catalog the lineup uses
// (expandRoster / findDuty), so the email can never state a time or duty that disagrees with what the
// review screen shows. Leads check in an hour earlier and their duty name is not in the catalog, so
// their description falls back to the duty they lead.
const { expandRoster, sessionRow, STATE_SUBMITTED, STATE_ENTERED } = require("../dutyalloc/dutyalloc");
const { findDuty, norm, clean } = require("./duties");

// "Committed to a lineup" — on the iVol lineup, or already entered in iVol. Entered is included so a
// fast-tracked assignment isn't missed; it was on the lineup on the way there anyway.
const ON_LINEUP = new Set([STATE_SUBMITTED, STATE_ENTERED]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const firstNameOf = (v) => clean(v.first) || clean(String(clean(v.name) || "").split(/\s+/)[0]) || "";
const hasEmail = (v) => EMAIL_RE.test(clean(v.email));

// Build the lookups enrichment needs, once, from the config blobs the endpoint reads.
//   sessions:    [{ id, name }]
//   rosterStore: { sessions: { sid: { area: [{ duty, min, leads, checkIn }] } } }
//   catalog:     [{ area, name, description }]
function buildLookups(sessions, rosterStore, catalog) {
  const sessionName = new Map((sessions || []).map(s => [String(s.id), clean(s.name)]));
  const bySession = (rosterStore && rosterStore.sessions) || {};
  // Expanded roster (base rows + derived lead rows) for one session+area — the shape whose check-in
  // matches a person's assigned duty exactly, the way the review screen matches it.
  const specsFor = (sid, area) => {
    const byArea = bySession[String(sid)] || {};
    const rows = byArea[area] != null ? byArea[area] : (byArea[clean(area)] || []);
    return expandRoster(rows);
  };
  return { sessionName, specsFor, catalog: catalog || [] };
}

// Enrich ONE volunteer's session row into the fields the email needs. Returns null if they have no
// row for this session at all.
function enrichOne(v, sid, lookups) {
  const row = sessionRow(v, sid);
  if (!row) return null;
  const area = clean(row.area);
  const dutyName = clean(row.duty);
  const spec = lookups.specsFor(sid, area).find(s => norm(s.duty) === norm(dutyName)) || null;
  const checkIn = spec ? clean(spec.checkIn) : "";
  // A lead's duty name isn't in the catalog (the catalog holds the base duty), so look up the duty
  // they lead for the description.
  const baseName = spec && spec.isLead && spec.leadOf ? spec.leadOf : dutyName;
  const cat = findDuty(lookups.catalog, area, baseName);
  return {
    user_id: String(v.user_id), region: clean(v.region), email: clean(v.email),
    name: firstNameOf(v), sessionId: String(sid),
    sessionName: lookups.sessionName.get(String(sid)) || "",
    area, dutyName, description: cat ? clean(cat.description) : "",
    checkIn, isLead: !!(spec && spec.isLead), state: clean(row.state),
    notified_at: row.notified_at || null,
  };
}

// Split a session's members into who WOULD get an email now, who is on the lineup but has no address
// (so they can be phoned), and how many were already emailed for this row.
//   eligible = on a lineup (submitted/entered) AND not yet notified AND has an email
function selectForSession(records, sid, lookups) {
  const eligible = [], noEmail = [];
  let alreadySent = 0, onLineup = 0;
  for (const v of (records || [])) {
    const row = sessionRow(v, sid);
    if (!row || !ON_LINEUP.has(clean(row.state))) continue;
    onLineup++;
    if (row.notified_at) { alreadySent++; continue; }
    const e = enrichOne(v, sid, lookups);
    if (!e) continue;
    if (hasEmail(v)) eligible.push(e); else noEmail.push(e);
  }
  return { eligible, noEmail, alreadySent, onLineup };
}

// ---- The email ------------------------------------------------------------------------------------
const SENDER_NAME = "Volunteer Experience Team";
const EVENT_LABEL = "Ismaili Western Canada Didar";
const REPLY_TO = "volunteer.experience@iicanada.net";
const LOUNGE = "Volunteer Check-In Lounge";
const SUBJECT = "Your Didar volunteer duty is confirmed";
const PREHEADER = "Your session, check-in time, and duty \u2014 everything you need for the day.";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

// Render the approved message for one enriched recipient. Returns { subject, html, text }. Pure — the
// same input always yields the same bytes, so a test pins the wording and a dry-run shows the real thing.
function renderDutyEmail(r, opts = {}) {
  const senderName = clean(opts.senderName) || SENDER_NAME;
  const name = clean(r.name) || "Volunteer";
  const session = clean(r.sessionName) || "the Didar";
  const duty = clean(r.dutyName);
  const desc = clean(r.description);
  const time = clean(r.checkIn);

  const text = [
    `Dear ${name},`, "",
    `Congratulations! We are pleased to inform you that you have been invited to volunteer at the ${session}. Below are the details of your assignment:`, "",
    `Duty Name: ${duty}`,
    `Duty Description: ${desc}`, "",
    `Please arrive at the ${LOUNGE} at: ${time}`, "",
    "Thank you for your commitment and support. We truly appreciate your willingness to serve and look forward to your participation.", "",
    senderName, EVENT_LABEL, "",
    `\u2014`, `You're receiving this because you volunteered for the Didar. Replies go to ${REPLY_TO}.`,
  ].join("\n");

  const row = (label, value) => `<tr>
      <td style="padding:7px 0; color:#61708a; width:150px; vertical-align:top; font-size:14px;">${esc(label)}</td>
      <td style="padding:7px 0; color:#1f2733; font-size:14px; line-height:1.55;">${value}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(SUBJECT)}</title></head>
<body style="margin:0; padding:0; background:#e9edf2;">
<div style="display:none; max-height:0; overflow:hidden; font-size:1px; line-height:1px; color:#e9edf2;">${esc(PREHEADER)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9edf2;"><tr><td align="center" style="padding:24px 12px 32px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%; max-width:600px; background:#ffffff; border:1px solid #dbe1e9; border-radius:10px; overflow:hidden;">
    <tr><td style="background:#1f3a5f; padding:22px 30px;">
      <div style="font-family:Georgia,'Times New Roman',serif; color:#ffffff; font-size:19px; font-weight:bold; line-height:1.2;">${esc(senderName)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif; color:#b9c7db; font-size:13px; margin-top:3px;">${esc(EVENT_LABEL)}</div>
    </td></tr>
    <tr><td style="padding:30px; font-family:Arial,Helvetica,sans-serif;">
      <p style="margin:0 0 16px; color:#1f2733; font-size:15px; line-height:1.65;">Dear ${esc(name)},</p>
      <p style="margin:0 0 18px; color:#1f2733; font-size:15px; line-height:1.65;">Congratulations! We are pleased to inform you that you have been invited to volunteer at the <b>${esc(session)}</b>. Below are the details of your assignment:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e7ee; border-radius:8px; background:#f7f9fc; margin:0 0 20px;"><tr><td style="padding:18px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;">
          ${row("Duty Name", `<b>${esc(duty)}</b>`)}
          ${row("Duty Description", esc(desc))}
        </table>
      </td></tr></table>
      <p style="margin:0 0 20px; color:#1f2733; font-size:15px; line-height:1.65;">Please arrive at the ${esc(LOUNGE)} at: <b>${esc(time)}</b></p>
      <p style="margin:0 0 8px; color:#1f2733; font-size:15px; line-height:1.65;">Thank you for your commitment and support. We truly appreciate your willingness to serve and look forward to your participation.</p>
      <p style="margin:24px 0 0; color:#1f2733; font-size:15px; line-height:1.6;"><span style="font-weight:bold;">${esc(senderName)}</span><br><span style="color:#61708a; font-size:13px;">${esc(EVENT_LABEL)}</span></p>
    </td></tr>
    <tr><td style="background:#f3f6f9; padding:16px 30px; border-top:1px solid #e2e7ee;">
      <p style="margin:0; color:#8592a3; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:1.55;">You're receiving this because you volunteered for the Didar. Replies go to the ${esc(senderName)} (${esc(REPLY_TO)}).</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return { subject: SUBJECT, html, text };
}

module.exports = {
  buildLookups, enrichOne, selectForSession, renderDutyEmail, hasEmail,
  ON_LINEUP, SENDER_NAME, EVENT_LABEL, REPLY_TO, LOUNGE, SUBJECT,
};
