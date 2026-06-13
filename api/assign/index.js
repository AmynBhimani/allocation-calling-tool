const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
const AREAS = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics",
  "Registration & Access", "Medical Services",
  "Finance & Procurement", "Environmental Sustainability"
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
function slim(v) {
  return {
    id: v.user_id, first: v.first, last: v.last, region: v.region, jk: v.ceremony_jk,
    final: v.final_area, status: v.callable_status,
    affinity: !!v.affinity_flag, leader: !!v.leader_flag, new: !!v.never_reviewed,
    no_bi: !!v.no_bi_account, referred_from: v.referred_from || null,
    assigned: v.assigned_caller || null
  };
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
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
      const out = [];
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          if (inScope(scopes, v.final_area, v.region) && v.callable_status === "Stable") out.push(slim(v));
        }
      }
      // callers available within these scopes (for the assign dropdown)
      const callers = store.filter(a => clean(a.role) === "caller" && inScope(scopes, clean(a.area), clean(a.region)))
        .map(a => ({ email: clean(a.email), area: clean(a.area), region: clean(a.region) }));
      context.res = { body: { volunteers: out, scopes, callers, count: out.length } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const op = clean(body.op).toLowerCase() || "assign";
      const region = clean(body.region);
      const ids = Array.isArray(body.user_ids) ? body.user_ids : (body.user_id != null ? [body.user_id] : []);
      const caller = clean(body.caller_email).toLowerCase();
      if (!REGIONS.includes(region)) { context.res = { status: 400, body: { error: "Valid region required." } }; return; }
      if (!ids.length) { context.res = { status: 400, body: { error: "No volunteers selected." } }; return; }

      if (op === "assign") {
        if (!caller) { context.res = { status: 400, body: { error: "A caller is required." } }; return; }
        // caller must be a caller within one of the requester's scopes
        const callerOk = store.some(a => clean(a.email).toLowerCase() === caller && clean(a.role) === "caller"
          && inScope(scopes, clean(a.area), clean(a.region)));
        if (!callerOk) { context.res = { status: 403, body: { error: "That caller isn't in your area." } }; return; }
      }

      let done = 0, skipped = 0;
      for (const id of ids) {
        const result = await mutateVolunteer(container, region, id, (v) => {
          // only act on volunteers in this requester's scope and callable
          if (!inScope(scopes, v.final_area, v.region) || v.callable_status !== "Stable") return { skip: true };
          v.activity_log = v.activity_log || [];
          if (op === "unassign") {
            v.assigned_caller = null;
            v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "unassign" });
          } else {
            v.assigned_caller = caller;
            v.call_done = false;          // fresh for the new caller (handles referred-in / reassigned)
            v.call_outcome = null;
            v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "assign", to: caller });
          }
        });
        if (result.ok && !(result.extra && result.extra.skip)) done++; else skipped++;
      }
      context.res = { body: { ok: true, op, done, skipped, caller: op === "assign" ? caller : null } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
