// All Volunteers view: every volunteer with their allocation/calling status, plus the dashboard tiles
// (Total, Allocated to an area, Accepted, Call pending, To be assigned to a caller). Super/Admin only,
// region-walled to the caller's events like the rest of the tool.
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { lastOutcome } = require("../shared/rollup");

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

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    if (!email || !(roles.includes("superadmin") || roles.includes("admin") || roles.includes("leadership"))) {
      context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return;
    }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const isSuper = roles.includes("superadmin");
    const allowed = (isSuper || roles.includes("leadership")) ? null : allowedRegionsFor(await readRolesStore(), email);
    const scopeRegions = allowed ? REGIONS.filter(r => allowed.includes(r)) : REGIONS;
    const only = req.query && req.query.region;
    const regions = (only && scopeRegions.includes(only)) ? [only] : scopeRegions;

    const container = await getContainer(DATA_CONTAINER);
    const vols = [];
    const tiles = { total: 0, allocated: 0, accepted: 0, callPending: 0, toAssign: 0 };

    for (const region of regions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        const status = v.callable_status || "Unassigned";
        const isLeadership = status === LEADERSHIP;
        const area = v.final_area || null;
        const accepted = !!v.ivol_ready || lastOutcome(v) === "Accepted";
        const callerAssigned = !!v.assigned_caller;
        const callPending = callerAssigned && !v.call_done;                       // on a caller list, not yet called
        const toAssign = !!area && status === "Stable" && !callerAssigned && !accepted; // allocated, ready, no caller yet
        const needsDecision = status === "In reconciliation";                     // conflicting review claims

        tiles.total++;
        if (area && !isLeadership) tiles.allocated++;
        if (accepted) tiles.accepted++;
        if (callPending) tiles.callPending++;
        if (toAssign) tiles.toAssign++;

        vols.push({
          id: v.user_id, name: ((v.first || "") + " " + (v.last || "")).trim() || "(no name)",
          region, jk: v.ceremony_jk || "", area, status,
          accepted, callerAssigned, callPending, toAssign, needsDecision, age: ageOf(v),
        });
      }
    }
    vols.sort((a, b) => (a.region + a.name).localeCompare(b.region + b.name));
    context.res = { body: { volunteers: vols, tiles, regions: scopeRegions } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
