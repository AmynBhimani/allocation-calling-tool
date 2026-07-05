const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, mutateVolunteer, REGIONS, readDidars } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
const AREAS = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics",
  "Registration & Access", "Medical Services", "Diverse Abilities Support",
  "Finance & Procurement", "Environmental Sustainability", "Memorabilia & Design", "Jamati Preparation"
];

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
function scopesFor(store, email, role) {
  return store.filter(a => clean(a.email).toLowerCase() === email && clean(a.role) === role)
    .map(a => ({ area: clean(a.area), region: clean(a.region) }));
}
const inScope = (scopes, area, region) => scopes.some(s => s.area === area && s.region === region);

// Assignment view: names + status + assigned caller. No contact info (that's the caller's screen).
function ageOf(v) {
  if (v.age != null && Number.isFinite(Number(v.age))) return Number(v.age);
  if (!v.birthday) return null;
  const d = new Date(v.birthday); if (isNaN(d)) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 130 ? a : null;
}
const iffOf = (v) => !!v.interfaith || v.list === "IFF";
function slim(v) {
  return {
    id: v.user_id, first: v.first, last: v.last, region: v.region, jk: v.ceremony_jk,
    final: v.final_area, status: v.callable_status, age: ageOf(v), iff: iffOf(v),
    affinity: !!v.affinity_flag, leader: !!v.leader_flag, new: !!v.never_reviewed,
    no_bi: !!v.no_bi_account, referred_from: v.referred_from || null, referral_reason: v.referral_reason || null,
    assigned: v.assigned_caller || null, outcome: v.call_outcome || null, duty: v.assigned_duty || null,
    dup: !!v.potential_duplicate
  };
}
// A volunteer is "resolved by a caller" once they Accepted or Withdrew. (Declined-referred clears
// call_outcome so the receiving area can reassign them, so it is NOT treated as resolved here.)
const RESOLVED_OUTCOMES = ["Accepted", "Withdrew", "Duplicate"];
const isResolved = (v) => RESOLVED_OUTCOMES.includes(v.call_outcome);

function lastOutcomeEntry(v) {
  let e = null;
  for (const x of (v.activity_log || [])) if (x.action === "outcome") e = x;
  return e;
}
// Resolved view carries the full call record so the quarterback's Completed tab can show it,
// mirroring the caller's Completed panel (events & all candidate duties + call history).
function resolvedSlim(v, didarMap) {
  const e = lastOutcomeEntry(v) || {};
  const eas = (Array.isArray(v.event_assignments) ? v.event_assignments : []).map(a => ({
    event: a.event, eventName: (didarMap && didarMap[a.event]) || a.event,
    candidate_duties: Array.isArray(a.candidate_duties) ? a.candidate_duties : [],
    duty: a.duty || null, area: a.area || v.final_area || null,
  }));
  return {
    id: v.user_id, first: v.first, last: v.last, region: v.region, jk: v.ceremony_jk,
    final: v.final_area, outcome: v.call_outcome || null, assigned: v.assigned_caller || null,
    duty: v.assigned_duty || null, note: e.note || null, when: e.ts || null,
    confirmed: !!v.confirmed_at, ivol_ready: !!v.ivol_ready,
    leader: !!v.leader_flag, affinity: !!v.affinity_flag, no_bi: !!v.no_bi_account, referred_from: v.referred_from || null,
    event_assignments: eas,
    log: (v.activity_log || []).filter(x => x.action === "outcome").map(x => ({ ts: x.ts, outcome: x.outcome, note: x.note || null })),
  };
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin"); // only Super Admin is global; admins are walled to their events
    const isQB = roles.includes("quarterback");
    if (!email || (!isSuper && !isQB)) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const store = await readRoles();
    // Super Admin may act for any scope (optionally narrowed by ?area=&region=); a quarterback is
    // limited to their own area×region scopes.
    let scopes = scopesFor(store, email, "quarterback");
    if (isSuper) {
      const qa = clean(req.query.area), qr = clean(req.query.region);
      scopes = (qa && qr) ? [{ area: qa, region: qr }]
        : REGIONS.flatMap(r => AREAS.map(a => ({ area: a, region: r }))); // all
    }
    if (!scopes.length) { context.res = { status: 200, body: { volunteers: [], scopes: [], callers: [] } }; return; }

    const scopeRegions = [...new Set(scopes.map(s => s.region))];
    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const didars = await readDidars();
      const didarMap = {};
      for (const d of didars) didarMap[d.id] = d.name;
      const out = [];
      const resolved = [];
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          if (!inScope(scopes, v.final_area, v.region) || v.callable_status !== "Stable") continue;
          if (isResolved(v)) resolved.push(resolvedSlim(v, didarMap));   // already settled by a caller — not assignable
          else out.push(slim(v));
        }
      }
      // callers available within these scopes (for the assign dropdown)
      const callers = store.filter(a => clean(a.role) === "caller" && inScope(scopes, clean(a.area), clean(a.region)))
        .map(a => ({ email: clean(a.email), area: clean(a.area), region: clean(a.region) }));
      // Events (Didars) this QB can tag a caller to — those covering any of their regions.
      const events = didars.filter(d => Array.isArray(d.regions) && d.regions.some(r => scopeRegions.includes(r)))
        .map(d => ({ id: d.id, name: d.name, regions: d.regions }));
      context.res = { body: { volunteers: out, resolved, scopes, callers, events, count: out.length, resolvedCount: resolved.length } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const op = clean(body.op).toLowerCase() || "assign";
      const region = clean(body.region);
      const ids = Array.isArray(body.user_ids) ? body.user_ids : (body.user_id != null ? [body.user_id] : []);
      const caller = clean(body.caller_email).toLowerCase();
      const dutyMap = (body.duties && typeof body.duties === "object") ? body.duties : {};   // { id: dutyName } for assign
      const singleDuty = clean(body.duty);                                                   // for op:set_duty
      if (!REGIONS.includes(region)) { context.res = { status: 400, body: { error: "Valid region required." } }; return; }
      if (!ids.length) { context.res = { status: 400, body: { error: "No volunteers selected." } }; return; }

      let callerScopes = [];
      if (op === "assign") {
        if (!caller) { context.res = { status: 400, body: { error: "A caller is required." } }; return; }
        // caller must be a caller within one of the requester's scopes
        const callerOk = store.some(a => clean(a.email).toLowerCase() === caller && clean(a.role) === "caller"
          && inScope(scopes, clean(a.area), clean(a.region)));
        if (!callerOk) { context.res = { status: 403, body: { error: "That caller isn't in your area." } }; return; }
        // a volunteer can only be assigned to a caller whose OWN scope covers them
        callerScopes = scopesFor(store, caller, "caller");
      }

      let done = 0, skipped = 0, outOfCallerScope = 0;
      for (const id of ids) {
        const result = await mutateVolunteer(container, region, id, (v) => {
          // only act on volunteers in this requester's scope and callable
          if (!inScope(scopes, v.final_area, v.region) || v.callable_status !== "Stable") return { skip: true };
          if (op === "assign" && isResolved(v)) return { skip: true };   // settled by a caller — not reassignable
          if (op === "assign" && !inScope(callerScopes, v.final_area, v.region)) return { skip: true, reason: "caller_scope" };
          v.activity_log = v.activity_log || [];
          if (op === "unassign") {
            v.assigned_caller = null;
            v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "unassign" });
          } else if (op === "reopen") {
            // Quarterback re-opens a settled decision: back to the assignable pool, unassigned.
            v.assigned_caller = null; v.call_done = false; v.call_outcome = null; v.ivol_ready = false;
            v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "qb_reopen" });
          } else if (op === "set_duty") {
            v.assigned_duty = singleDuty || null;
            v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "set_duty", to: v.assigned_duty });
          } else {
            v.assigned_caller = caller;
            v.call_done = false;          // fresh for the new caller (handles referred-in / reassigned)
            v.call_outcome = null;
            const d = dutyMap[String(id)];                 // optional pre-assigned duty for this volunteer
            if (d !== undefined) v.assigned_duty = clean(d) || null;
            v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "assign", to: caller, duty: v.assigned_duty || null });
          }
        });
        if (result.ok && !(result.extra && result.extra.skip)) done++;
        else { skipped++; if (result.extra && result.extra.reason === "caller_scope") outOfCallerScope++; }
      }
      context.res = { body: { ok: true, op, done, skipped, outOfCallerScope, caller: op === "assign" ? caller : null } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
