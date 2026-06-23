const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");

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
function lastOutcome(v) {
  let o = null;
  for (const e of (v.activity_log || [])) if (e.action === "outcome") o = e.outcome;
  return o;
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

    const qRegion = String(req.query.region || "").trim();
    const regions = scopeRegions.includes(qRegion) ? [qRegion] : scopeRegions;
    const container = await getContainer(DATA_CONTAINER);

    const byArea = {};
    const blank = () => ({ assignedDuty: 0, accepted: 0, callPending: 0, declined: 0 });
    const totals = blank();

    for (const region of regions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        // only the callable pipeline (excludes Leadership-do-not-allocate)
        if (v.callable_status === "Leadership - Do Not Allocate") continue;
        const area = v.final_area || "(no area)";
        const b = byArea[area] || (byArea[area] = blank());
        const lo = lastOutcome(v);

        // A withdrawal is the only true decline — count it in their current area, not as a duty.
        if (lo === "Withdrew") { b.declined++; totals.declined++; continue; }
        // A confirmed duplicate is a data-cleanup drop-out — don't count it anywhere.
        if (lo === "Duplicate") continue;

        // Declined-referred: they've moved to their new area (final_area) and hold a duty there.
        // Count them as assigned in that area — never as a decline.
        if (v.callable_status === "Stable") { b.assignedDuty++; totals.assignedDuty++; }

        const isAccepted = !!v.ivol_ready || lo === "Accepted";
        const isCallPending = !!v.assigned_caller && !v.call_done;  // with a caller, call not completed

        if (isAccepted) { b.accepted++; totals.accepted++; }
        if (isCallPending) { b.callPending++; totals.callPending++; }
      }
    }

    const rows = Object.keys(byArea).sort().map(area => ({ area, ...byArea[area] }));
    context.res = { body: { region: scopeRegions.includes(qRegion) ? qRegion : "All", regions: scopeRegions, rows, totals } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
