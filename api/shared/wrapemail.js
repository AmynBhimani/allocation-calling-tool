// The two wrap-up emails: the acceptance ("you've been assigned") email and the No-Response email.
// Rendering matches the duty email's look (navy header band + white card). Session-specific check-in
// windows and per-region orientation days are baked in from the confirmed schedule.
const crypto = require("crypto");
const { classify } = require("./wrapup");
const { isAcceptedVolunteer } = require("./rollup");
const { sessionForJk } = require("./sessions");

// Arrival/check-in window, keyed by the exact session name in events.json.
const CHECKIN_BY_SESSION = {
  "July 24 Morning - Prairies": "2:00 am and 7:00 am",
  "July 24 Afternoon - Prairies / Edmonton": "6:00 am and 12:00 noon",
  "July 26 - British Columbia": "2:00 am and 6:00 am",
};
// All-Volunteer Orientation day, keyed by region.
const ORIENTATION_BY_REGION = { "Prairies": "July 23", "Edmonton": "July 23", "BC": "July 25" };

const NO_RESPONSE_STATUS = "Sent No Response Email";
const VE_EMAIL = "volunteer.experience@iicanada.net";
const SENDER_NAME = "Volunteer Experience Team";
const ASSIGN_SUBJECT = "Your Didar volunteer assignment";
const NO_RESPONSE_SUBJECT = "Following up on your Didar volunteer registration";

const clean = (s) => String(s == null ? "" : s).trim();
const norm = (s) => clean(s).toLowerCase();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hasEmail = (v) => !!clean(v && v.email);
const firstName = (v) => clean(v && v.first) || "Volunteer";
const newToken = () => crypto.randomBytes(24).toString("base64url");
const checkInFor = (sessionName) => CHECKIN_BY_SESSION[clean(sessionName)] || "";
const orientationFor = (region) => ORIENTATION_BY_REGION[clean(region)] || "";

function shell(innerHtml, subject, preheader) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(subject)}</title></head>
<body style="margin:0; padding:0; background:#e9edf2;">
<div style="display:none; max-height:0; overflow:hidden; font-size:1px; line-height:1px; color:#e9edf2;">${esc(preheader || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9edf2;"><tr><td align="center" style="padding:24px 12px 32px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%; max-width:600px; background:#ffffff; border:1px solid #dbe1e9; border-radius:10px; overflow:hidden;">
    <tr><td style="background:#1f3a5f; padding:22px 30px;">
      <div style="font-family:Georgia,'Times New Roman',serif; color:#ffffff; font-size:19px; font-weight:bold; line-height:1.2;">${esc(SENDER_NAME)}</div>
    </td></tr>
    <tr><td style="padding:30px; font-family:Arial,Helvetica,sans-serif;">${innerHtml}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
}
const P = (html) => `<p style="margin:0 0 16px; color:#1f2733; font-size:15px; line-height:1.65;">${html}</p>`;
const SIGN = `<p style="margin:20px 0 0; color:#1f2733; font-size:15px; line-height:1.6;"><b>Your Volunteer Experience Team</b></p>`;

// r: { first, area, checkIn, orientation, declineUrl }
function renderAssignEmail(r) {
  const first = clean(r.first) || "Volunteer";
  const area = clean(r.area) || "your assigned";
  const time = clean(r.checkIn);
  const orientation = clean(r.orientation);
  const declineUrl = clean(r.declineUrl);

  const text = [
    `Ya Ali Madad Dear ${first},`, "",
    `Mubaraki to you! We truly appreciate your niyat to serve during the upcoming didar. We appreciate your patience as we confirmed the volunteer information for Didar day. You have been assigned a duty in the ${area} area. The details of your duty will be emailed to you separately no later than Wednesday afternoon. If you have not received an email by Wednesday July 22, please contact the Volunteer Experience Team at the email below.`, "",
    `Your check in time will be between ${time}.`, "",
    "Your exact check in time will be confirmed in your duty confirmation email.", "",
    `We would also like to invite you to an All Volunteer Orientation on ${orientation}. Details and registration instructions will be sent to you shortly.`, "",
    "If your circumstances have changed and you are no longer able to volunteer, please use the link below to decline this duty:",
    declineUrl, "",
    `If you have any questions or concerns, feel free to reach out to us at ${VE_EMAIL}.`, "",
    "Didar Mubarak!", "", "Your Volunteer Experience Team",
  ].join("\n");

  const inner =
    P(`Ya Ali Madad Dear ${esc(first)},`) +
    P(`Mubaraki to you! We truly appreciate your niyat to serve during the upcoming didar. We appreciate your patience as we confirmed the volunteer information for Didar day. You have been assigned a duty in the <b>${esc(area)}</b> area. The details of your duty will be emailed to you separately no later than Wednesday afternoon. If you have not received an email by <b>Wednesday July 22</b>, please contact the Volunteer Experience Team at the email below.`) +
    P(`Your check in time will be between <b>${esc(time)}</b>.`) +
    `<p style="margin:0 0 16px; color:#61708a; font-size:13.5px; line-height:1.6; font-style:italic;">Your exact check in time will be confirmed in your duty confirmation email.</p>` +
    P(`We would also like to invite you to an <b>All Volunteer Orientation on ${esc(orientation)}</b>. Details and registration instructions will be sent to you shortly.`) +
    P("If your circumstances have changed and you are no longer able to volunteer, please use the button below to decline this duty:") +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 8px;"><tr><td style="border-radius:8px; background:#C44536;">` +
      `<a href="${esc(declineUrl)}" style="display:inline-block; padding:12px 22px; font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:bold; color:#ffffff; text-decoration:none; border-radius:8px;">I can no longer volunteer &mdash; decline</a>` +
      `</td></tr></table>` +
    `<p style="margin:0 0 18px; color:#8a97a6; font-size:12px; line-height:1.5;">If the button doesn\u2019t work, copy and paste this link:<br><span style="color:#61708a;">${esc(declineUrl)}</span></p>` +
    P(`If you have any questions or concerns, feel free to reach out to us at <a href="mailto:${esc(VE_EMAIL)}" style="color:#1f3a5f;">${esc(VE_EMAIL)}</a>.`) +
    P("Didar Mubarak!") + SIGN;

  return { subject: ASSIGN_SUBJECT, html: shell(inner, ASSIGN_SUBJECT, "You\u2019ve been assigned a volunteer duty for the Didar \u2014 your check-in time and next steps inside."), text };
}

// r: { first }
function renderNoResponseEmail(r) {
  const first = clean(r.first) || "Volunteer";
  const text = [
    `Ya Ali Madad Dear ${first},`, "",
    `Mubaraki to you! We truly appreciate your niyat to serve during the upcoming didar. We have attempted to contact you by phone or email and have not been able to connect. If you are still interested in volunteering, please email us at ${VE_EMAIL} and someone will reach out to you to allocate you a duty.`, "",
    "Didar Mubarak!", "", "Your Volunteer Experience Team",
  ].join("\n");
  const inner =
    P(`Ya Ali Madad Dear ${esc(first)},`) +
    P(`Mubaraki to you! We truly appreciate your niyat to serve during the upcoming didar. We have attempted to contact you by phone or email and have not been able to connect. If you are still interested in volunteering, please email us at <a href="mailto:${esc(VE_EMAIL)}" style="color:#1f3a5f;">${esc(VE_EMAIL)}</a> and someone will reach out to you to allocate you a duty.`) +
    P("Didar Mubarak!") + SIGN;
  return { subject: NO_RESPONSE_SUBJECT, html: shell(inner, NO_RESPONSE_SUBJECT, "We weren\u2019t able to reach you about volunteering for the Didar."), text };
}

// ---- audience selection ----
// Acceptance email: accepted people whose Jamatkhana maps to `sid`, deduped, not yet sent. Carries any
// existing decline_token so a re-send reuses the link a volunteer may already hold.
function selectAcceptedForSession(records, sid, jkIndex) {
  const eligible = [], noEmail = [];
  let alreadySent = 0, noSession = 0;
  const seen = new Set(), seenNs = new Set();
  for (const v of (records || [])) {
    if (!isAcceptedVolunteer(v)) continue;
    const uid = String(v.user_id);
    const theirSid = sessionForJk(jkIndex, v.ceremony_jk);
    if (!theirSid) { if (!seenNs.has(uid)) { seenNs.add(uid); noSession++; } continue; }
    if (String(theirSid) !== String(sid)) continue;
    if (seen.has(uid)) continue;
    seen.add(uid);
    if (v.accepted_notified_at) { alreadySent++; continue; }
    const rec = { user_id: v.user_id, region: v.region, name: clean((v.first || "") + " " + (v.last || "")),
      first: firstName(v), area: clean(v.final_area), email: clean(v.email), decline_token: v.decline_token || null };
    if (hasEmail(v)) eligible.push(rec); else noEmail.push(rec);
  }
  return { eligible, noEmail, alreadySent, noSession };
}

// No-Response email: exactly the mass-accept "unreached" bucket (No answer / Thinking / Emailed), deduped,
// not yet emailed (no_response_status not set).
function selectUnreached(records) {
  const eligible = [], noEmail = [];
  let alreadySent = 0;
  const seen = new Set();
  for (const v of (records || [])) {
    if (classify(v) !== "unreached") continue;
    const uid = String(v.user_id);
    if (seen.has(uid)) continue;
    seen.add(uid);
    if (clean(v.no_response_status) === NO_RESPONSE_STATUS) { alreadySent++; continue; }
    const rec = { user_id: v.user_id, region: v.region, name: clean((v.first || "") + " " + (v.last || "")), first: firstName(v), email: clean(v.email) };
    if (hasEmail(v)) eligible.push(rec); else noEmail.push(rec);
  }
  return { eligible, noEmail, alreadySent };
}

// ---- stamps (mergeRegion mutators) ----
// sentTokens: Map<user_id, decline_token used>. Sets accepted_notified_at and persists the token.
function stampAcceptedSent(records, sentTokens, nowIso) {
  for (const v of (records || [])) {
    const uid = String(v.user_id);
    if (!sentTokens.has(uid)) continue;
    v.accepted_notified_at = nowIso;
    v.decline_token = sentTokens.get(uid);
  }
  return records;
}
function stampNoResponseSent(records, sentSet, nowIso) {
  for (const v of (records || [])) {
    if (!sentSet.has(String(v.user_id))) continue;
    v.no_response_status = NO_RESPONSE_STATUS;
    v.no_response_sent_at = nowIso;
  }
  return records;
}

module.exports = {
  renderAssignEmail, renderNoResponseEmail, selectAcceptedForSession, selectUnreached,
  stampAcceptedSent, stampNoResponseSent, checkInFor, orientationFor, hasEmail, newToken,
  CHECKIN_BY_SESSION, ORIENTATION_BY_REGION, NO_RESPONSE_STATUS, VE_EMAIL,
  ASSIGN_SUBJECT, NO_RESPONSE_SUBJECT,
};
