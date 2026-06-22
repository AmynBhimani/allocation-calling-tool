const { getContainer, readRegion, mutateVolunteer, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");

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
function acceptedAt(v) {
  let when = null;
  for (const e of (v.activity_log || [])) {
    if (e.action === "outcome" && e.outcome === "Accepted") when = e.ts;
  }
  return when;
}
function row(v) {
  return {
    id: v.user_id, first: v.first, last: v.last, username: v.username || "",
    region: v.region, jk: v.ceremony_jk, committee: v.final_area,
    outcome: "Accepted", accepted_at: acceptedAt(v), entered: !!v.ivol_entered
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

    // Region wall: super-admins see all; admins are limited to their tagged events' regions.
    const isSuper = roles.includes("superadmin");
    const allowRegions = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const scopeRegions = allowRegions ? REGIONS.filter(r => allowRegions.includes(r)) : REGIONS;
    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const includeEntered = req.query.all === "1";
      const out = [];
      let pendingCount = 0, enteredCount = 0;
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          if (!v.ivol_ready) continue;
          if (!acceptedAt(v)) continue;                 // hide rows that were never actually Accepted
          if (v.ivol_entered) enteredCount++; else pendingCount++;
          if (!includeEntered && v.ivol_entered) continue;
          out.push(row(v));
        }
      }
      out.sort((a, b) => (a.region.localeCompare(b.region)) || (a.committee || "").localeCompare(b.committee || "") || a.last.localeCompare(b.last));
      context.res = { body: { rows: out, count: out.length, pendingCount, enteredCount, total: pendingCount + enteredCount } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items : [];   // [{user_id, region}]
      const entered = body.entered !== false;                      // default true
      if (!items.length) { context.res = { status: 400, body: { error: "No volunteers given." } }; return; }
      let done = 0;
      for (const it of items) {
        if (!scopeRegions.includes(it.region)) continue;
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
