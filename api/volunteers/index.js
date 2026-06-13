const { getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const LEADERSHIP = "Leadership - Do Not Allocate";

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

// Reconciliation view never exposes contact info (scoped-access principle).
function slim(v) {
  return {
    id: v.user_id, first: v.first, last: v.last, region: v.region, jk: v.ceremony_jk,
    computed: v.computed_area, final: v.final_area, status: v.callable_status,
    affinity: !!v.affinity_flag, leader: !!v.leader_flag, new: !!v.never_reviewed,
    no_bi: !!v.no_bi_account,
    claims: v.conflict_claims || []
  };
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const canRecon = roles.includes("superadmin") || roles.includes("admin") || roles.includes("dutyteam");
    if (!email || !canRecon) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const only = req.query.region;
      const regions = only && REGIONS.includes(only) ? [only] : REGIONS;
      const out = [];
      for (const r of regions) {
        const { records } = await readRegion(container, r);
        for (const v of records) out.push(slim(v));
      }
      context.res = { body: { volunteers: out, count: out.length } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const { user_id, region } = body;
      const op = (body.op || "final_area").toLowerCase();
      if (user_id == null || !region || !REGIONS.includes(region)) {
        context.res = { status: 400, body: { error: "user_id and a valid region are required." } };
        return;
      }

      const result = await mutateVolunteer(container, region, user_id, (v) => {
        v.activity_log = v.activity_log || [];
        if (op === "leadership") {
          v._prev_final = v.final_area;
          v.final_area = null;
          v.callable_status = LEADERSHIP;
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "set_leadership_dna" });
        } else if (op === "clear_leadership") {
          v.final_area = v._prev_final != null ? v._prev_final : v.computed_area;
          v.callable_status = v.final_area ? "Stable" : "Unassigned";
          delete v._prev_final;
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "clear_leadership_dna" });
        } else {
          const fa = body.final_area;
          const hold = fa === "__hold__" || fa === null || fa === "";
          const before = v.final_area;
          v.final_area = hold ? null : fa;
          v.callable_status = hold ? "Unassigned" : "Stable";
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "set_final_area", from: before || null, to: v.final_area || null });
        }
      });

      if (result.notFound) { context.res = { status: 404, body: { error: "Volunteer not found in region." } }; return; }
      if (!result.ok) { context.res = { status: 409, body: { error: "Could not save due to concurrent edits — please retry." } }; return; }
      context.res = { body: { ok: true, volunteer: slim(result.volunteer) } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
