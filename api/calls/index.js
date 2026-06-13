const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";

const TERMINAL = ["Accepted", "Declined-referred", "Withdrew"]; // leave the active queue
const ALL_OUTCOMES = TERMINAL.concat(["No answer", "Thinking"]);

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
    referred_from: v.referred_from || null,
    outcome: v.call_outcome || null, done: !!v.call_done, followup: v.followup || null,
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

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const me = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isCaller = roles.includes("caller");
    const isSuper = roles.includes("superadmin");
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
          if (mineNow && !v.call_done) active.push(full(v));
          else if (loggedByMe(v, me)) {
            const f = full(v);
            const mine = (v.activity_log || []).filter(e => e.actor === me && e.action === "outcome").pop();
            if (mine) f.outcome = mine.outcome;   // show what I logged, even if the record moved on
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
      const followup = clean(body.followup_date);
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
          // assigned_caller stays, so it reappears in that caller's active list
        });
        if (rr.notFound) { context.res = { status: 404, body: { error: "Volunteer not found." } }; return; }
        if (rr.extra && rr.extra.skip) { context.res = { status: 403, body: { error: "That volunteer isn't assigned to you." } }; return; }
        if (!rr.ok) { context.res = { status: 409, body: { error: "Couldn't reopen — please retry." } }; return; }
        context.res = { body: { ok: true, reopened: true } };
        return;
      }

      if (!ALL_OUTCOMES.includes(outcome)) { context.res = { status: 400, body: { error: "Unknown outcome." } }; return; }
      if (outcome === "Declined-referred" && !referralArea) { context.res = { status: 400, body: { error: "Pick an area to refer to." } }; return; }

      const result = await mutateVolunteer(container, region, user_id, (v) => {
        if (v.assigned_caller !== me && !isSuper) return { skip: true };
        v.activity_log = v.activity_log || [];
        // optional contact correction (name / email / phone) — flagged for iVol to update in BI
        applyContact(v, contact);
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
        } else {
          // No answer / Thinking — stays in the active queue
          v.call_done = false;
          if (outcome === "Thinking" && followup) v.followup = followup;
        }
      });

      if (result.notFound) { context.res = { status: 404, body: { error: "Volunteer not found." } }; return; }
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
