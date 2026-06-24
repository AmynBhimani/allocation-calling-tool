const crypto = require("crypto");
const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";

const TERMINAL = ["Accepted", "Declined-referred", "Withdrew", "Duplicate"]; // leave the active queue
const ALL_OUTCOMES = TERMINAL.concat(["No answer", "Thinking", "Emailed"]); // non-terminal: No answer / Thinking / Emailed

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
function emailOf(p) {
  if (!p) return null;
  let e = p.userDetails || null;
  if (!e && Array.isArray(p.claims)) {
    const c = p.claims.find(c => /(emailaddress|email|preferred_username|upn)$/i.test(c.typ || c.type || ""));
    if (c) e = c.val || c.value;
  }
  return e ? String(e).toLowerCase() : null;
}
function streamToString(s) {
  return new Promise((res, rej) => {
    const ch = []; s.on("data", d => ch.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(ch).toString("utf8"))); s.on("error", rej);
  });
}
const clean = s => String(s == null ? "" : s).trim();
async function readRoles() {
  const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
  await c.createIfNotExists();
  const b = c.getBlockBlobClient("roles.json");
  if (!(await b.exists())) return [];
  try {
    const obj = JSON.parse(await streamToString((await b.download()).readableStreamBody));
    return Array.isArray(obj) ? obj : (obj.assignments || []);
  } catch { return []; }
}

// Caller sees full contact info — but ONLY for their own people.
function full(v) {
  return {
    id: v.user_id, first: v.first, last: v.last, region: v.region, jk: v.ceremony_jk,
    area: v.final_area, cell: v.cell_phone || "", email: v.email || "",
    home: v.home_phone || "", work: v.work_phone || "",
    leader: !!v.leader_flag, affinity: !!v.affinity_flag, no_bi_account: !!v.no_bi_account,
    referred_from: v.referred_from || null, referral_reason: v.referral_reason || null,
    outcome: v.call_outcome || null, done: !!v.call_done,
    duty: v.assigned_duty || null,
    potential_duplicate: v.potential_duplicate || null,
    confirm_sent: !!v.confirm_sent_at, confirmed: !!v.confirmed_at,
    event_assignments: Array.isArray(v.event_assignments) ? v.event_assignments : [],
    log: (v.activity_log || []).filter(e => e.action === "outcome")
  };
}
function loggedByMe(v, me) {
  return (v.activity_log || []).some(e => e.actor === me && e.action === "outcome");
}

function applyContact(v, contact) {
  if (!contact) return;
  v.contact_changes = v.contact_changes || {};
  const map = { first: "first", last: "last", email: "email", cell: "cell_phone" };
  for (const [k, field] of Object.entries(map)) {
    if (contact[k] == null) continue;
    const nv = clean(contact[k]);
    const cur = clean(v[field]);
    if (nv === cur) continue;
    if (!v.contact_changes[field]) v.contact_changes[field] = { from: cur };
    if (clean(v.contact_changes[field].from) === nv) delete v.contact_changes[field]; // edited back to original
    else v.contact_changes[field].to = nv;
    v[field] = nv;
  }
  v.bi_update_needed = Object.keys(v.contact_changes).length > 0;
}

// Normalize the per-event duty-capture rows from the caller. Deferred-session model:
// area + multiple candidate duties are captured now; the single committed duty, session,
// and session/support basis are filled later, so they stay null/pending here.
function normAssignments(arr) {
  if (!Array.isArray(arr)) return null; // null => caller didn't send any; leave existing untouched
  const out = [];
  for (const a of arr) {
    const event = clean(a && a.event);
    if (!event) continue;
    out.push({
      event,
      area: clean(a.area),
      candidate_duties: Array.isArray(a.candidate_duties)
        ? [...new Set(a.candidate_duties.map(clean).filter(Boolean))] : [],
      duty: a.duty ? clean(a.duty) : null,
      basis: clean(a.basis) || "pending",
      state: clean(a.state) || "confirmed",
    });
  }
  return out;
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const me = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isCaller = roles.includes("caller");
    const isSuper = roles.includes("superadmin"); // only Super Admin is global; admins are walled to their events
    if (!me || (!isCaller && !isSuper)) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    // caller's regions come from their role-store entries (callers can span regions)
    const store = await readRoles();
    let myRegions = [...new Set(store.filter(a => clean(a.email).toLowerCase() === me && clean(a.role) === "caller").map(a => clean(a.region)))];
    if (isSuper && !myRegions.length) myRegions = REGIONS.slice(); // super can test across all
    if (!myRegions.length) { context.res = { body: { active: [], completed: [] } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const active = [], completed = [];
      for (const region of myRegions) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          const mineNow = v.assigned_caller === me;
          if (mineNow && !v.call_done) { active.push(full(v)); continue; }
          const iLoggedOutcome = loggedByMe(v, me);
          const iSentEmail = (v.activity_log || []).some(e => e.actor === me && e.action === "confirm_email_sent");
          // show in Done if I logged an outcome, OR it's mine/I emailed it and it's now done (e.g. self-confirmed via the link)
          if (iLoggedOutcome || ((mineNow || iSentEmail) && v.call_done)) {
            const f = full(v);
            // latest outcome from me or from the volunteer's own link-accept (which my email triggered)
            const rel = (v.activity_log || []).filter(e => e.action === "outcome" && (e.actor === me || e.actor === "self-confirm")).pop();
            if (rel) f.outcome = rel.outcome;
            else if (v.call_outcome) f.outcome = v.call_outcome;
            completed.push(f);
          }
        }
      }
      context.res = { body: { active, completed, activeCount: active.length, completedCount: completed.length } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const region = clean(body.region);
      const user_id = body.user_id;
      const outcome = clean(body.outcome);
      const note = clean(body.note);
      const referralArea = clean(body.referral_area);
      const contact = body.contact || null;
      const op = clean(body.op);
      if (!REGIONS.includes(region) || user_id == null) { context.res = { status: 400, body: { error: "Valid region and user_id required." } }; return; }

      // Reopen: they changed their mind after the call — return them to the active queue.
      if (op === "reopen") {
        const rr = await mutateVolunteer(container, region, user_id, (v) => {
          if (v.assigned_caller !== me && !isSuper) return { skip: true };
          v.activity_log = v.activity_log || [];
          v.activity_log.push({ ts: new Date().toISOString(), actor: me, action: "reopen", from: v.call_outcome || null });
          if (v.ivol_entered) v.bi_correction_needed = true;   // was entered in BI, now reopened → iVol must correct
          v.call_done = false; v.call_outcome = null; v.ivol_ready = false;
          v.confirm_token = null; v.confirm_sent_at = null; v.confirmed_at = null;
          // assigned_caller stays, so it reappears in that caller's active list
        });
        if (rr.notFound) { context.res = { status: 404, body: { error: "Volunteer not found." } }; return; }
        if (rr.extra && rr.extra.skip) { context.res = { status: 403, body: { error: "That volunteer isn't assigned to you." } }; return; }
        if (!rr.ok) { context.res = { status: 409, body: { error: "Couldn't reopen — please retry." } }; return; }
        context.res = { body: { ok: true, reopened: true } };
        return;
      }

      // Generate a one-time confirmation link the caller emails from their own mail app.
      if (op === "send_confirm") {
        let info = null;
        const rr = await mutateVolunteer(container, region, user_id, (v) => {
          if (v.assigned_caller !== me && !isSuper) return { skip: true };
          const token = crypto.randomBytes(24).toString("base64url");
          v.confirm_token = token;
          v.confirm_sent_at = new Date().toISOString();
          v.confirmed_at = null;          // fresh send resets any prior confirmation state
          // Generating the email no longer sets the calling status. It only records that an
          // email was prepared (confirm_sent_at + the log entry below) and unlocks the
          // "Emailed" outcome button. The caller marks "Emailed" deliberately so the status
          // always reflects their most recent recorded action.
          v.activity_log = v.activity_log || [];
          v.activity_log.push({ ts: v.confirm_sent_at, actor: me, action: "confirm_email_sent" });
          const asg = normAssignments(body.event_assignments);
          if (asg) v.event_assignments = asg;
          info = { token, first: v.first, last: v.last, email: v.email || "", area: v.final_area || "" };
        });
        if (rr.notFound) { context.res = { status: 404, body: { error: "Volunteer not found." } }; return; }
        if (rr.extra && rr.extra.skip) { context.res = { status: 403, body: { error: "That volunteer isn't assigned to you." } }; return; }
        if (!rr.ok) { context.res = { status: 409, body: { error: "Couldn't prepare the email — please retry." } }; return; }
        context.res = { body: { ok: true, user_id, region, token: info.token, email: info.email, first: info.first, last: info.last, area: info.area } };
        return;
      }

      if (!ALL_OUTCOMES.includes(outcome)) { context.res = { status: 400, body: { error: "Unknown outcome." } }; return; }
      if (outcome === "Declined-referred" && !referralArea) { context.res = { status: 400, body: { error: "Pick an area to refer to." } }; return; }

      const result = await mutateVolunteer(container, region, user_id, (v) => {
        if (v.assigned_caller !== me && !isSuper) return { skip: true };
        // "Emailed" is only valid once the accept-link email has actually been generated.
        if (outcome === "Emailed" && !v.confirm_sent_at) return { skip: true, noEmail: true };
        v.activity_log = v.activity_log || [];
        // optional contact correction (name / email / phone) — flagged for iVol to update in BI
        applyContact(v, contact);
        // caller may adjust the pre-assigned duty (separate from the area the email confirms)
        if (body.assigned_duty !== undefined) v.assigned_duty = clean(body.assigned_duty) || null;
        // per-event duty capture (deferred-session model) — saved with the outcome
        const asg = normAssignments(body.event_assignments);
        if (asg) v.event_assignments = asg;
        const entry = { ts: new Date().toISOString(), actor: me, action: "outcome", outcome };
        if (note) entry.note = note;
        v.activity_log.push(entry);
        v.call_outcome = outcome;

        if (outcome === "Declined-referred") {
          v.referred_from = v.final_area;
          v.final_area = referralArea;
          v.assigned_caller = null;          // receiving area's QB will reassign
          v.callable_status = "Stable";
          v.call_done = true;                // done for me
          v.call_outcome = null;             // fresh for the receiving area
        } else if (outcome === "Accepted") {
          v.call_done = true;
          v.ivol_ready = true;               // flows to the iVol-input report
        } else if (outcome === "Withdrew") {
          v.call_done = true;
        } else if (outcome === "Duplicate") {
          // Caller confirmed this written-in person is already registered — drop them out.
          v.call_done = true;
        } else {
          // No answer / Thinking / Emailed — stays in the active queue
          v.call_done = false;
        }
      });

      if (result.notFound) { context.res = { status: 404, body: { error: "Volunteer not found." } }; return; }
      if (result.extra && result.extra.noEmail) { context.res = { status: 400, body: { error: "Create the accept-link email first, then mark Emailed." } }; return; }
      if (result.extra && result.extra.skip) { context.res = { status: 403, body: { error: "That volunteer isn't assigned to you." } }; return; }
      if (!result.ok) { context.res = { status: 409, body: { error: "Couldn't save — please retry." } }; return; }
      context.res = { body: { ok: true } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
