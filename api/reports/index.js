const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { rollupRecords, rowsFromByArea } = require("../shared/rollup");

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

    const acc = { byArea: {}, totals: { assignedDuty: 0, accepted: 0, callPending: 0, declined: 0 } };
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      rollupRecords(records, acc);
    }
    const rows = rowsFromByArea(acc.byArea);
    const totals = acc.totals;
    context.res = { body: { region: scopeRegions.includes(qRegion) ? qRegion : "All", regions: scopeRegions, rows, totals } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
