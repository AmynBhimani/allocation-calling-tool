const { getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

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

// One row per volunteer ready for Better Impact entry.
function row(v) {
  // when the call was accepted (last Accepted/Negotiated outcome)
  let when = null;
  for (const e of (v.activity_log || [])) {
    if (e.action === "outcome" && (e.outcome === "Accepted" || e.outcome === "Negotiated")) when = e.ts;
  }
  return {
    id: v.user_id, first: v.first, last: v.last, username: v.username || "",
    region: v.region, jk: v.ceremony_jk, committee: v.final_area,
    outcome: v.call_outcome, accepted_at: when, entered: !!v.ivol_entered
  };
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const allowed = roles.includes("superadmin") || roles.includes("admin");
    if (!email || !allowed) { context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const includeEntered = req.query.all === "1";
      const out = [];
      for (const region of REGIONS) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          if (!v.ivol_ready) continue;
          if (!includeEntered && v.ivol_entered) continue;
          out.push(row(v));
        }
      }
      out.sort((a, b) => (a.region.localeCompare(b.region)) || (a.committee || "").localeCompare(b.committee || "") || a.last.localeCompare(b.last));
      const pending = out.filter(r => !r.entered).length;
      context.res = { body: { rows: out, count: out.length, pending } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items : [];   // [{user_id, region}]
      const entered = body.entered !== false;                      // default true
      if (!items.length) { context.res = { status: 400, body: { error: "No volunteers given." } }; return; }
      let done = 0;
      for (const it of items) {
        if (!REGIONS.includes(it.region)) continue;
        const result = await mutateVolunteer(container, it.region, it.user_id, (v) => {
          v.activity_log = v.activity_log || [];
          v.ivol_entered = entered;
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: entered ? "ivol_entered" : "ivol_unentered" });
        });
        if (result.ok) done++;
      }
      context.res = { body: { ok: true, updated: done } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
