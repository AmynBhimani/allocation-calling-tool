const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor, readSessions } = require("../shared/store");
const { rollupRecords, rowsFromByArea, rollupByJk, jkGrid, isAcceptedVolunteer, blankCounts } = require("../shared/rollup");
const { rollupBySession, sessionGrid, sessionIdSet, sessionHealth } = require("../shared/sessions");
const { AREAS } = require("../shared/duties");

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
    const allowed = roles.includes("superadmin") || roles.includes("admin") || roles.includes("leadership");
    if (!email || !allowed) { context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    // Region wall: super-admins see all; admins are limited to their tagged events' regions.
    const isSuper = roles.includes("superadmin");
    const allowRegions = (isSuper || roles.includes("leadership")) ? null : allowedRegionsFor(await readRolesStore(), email);
    const scopeRegions = allowRegions ? REGIONS.filter(r => allowRegions.includes(r)) : REGIONS;

    const qRegion = String(req.query.region || "").trim();
    const regions = scopeRegions.includes(qRegion) ? [qRegion] : scopeRegions;
    const container = await getContainer(DATA_CONTAINER);

    // Sessions (all Didars): the committed session rosters, plus whether that picture is still current.
    const sessions = await readSessions(null);
    const sIds = sessionIdSet(sessions);

    const acc = { byArea: {}, totals: { assignedDuty: 0, accepted: 0, callPending: 0, declined: 0 } };
    // Seed every configured area so the "by area" table always lists them, even at zero. Otherwise a
    // newly-added area (nobody allocated to it yet) simply has no row and looks missing from the
    // dashboard. rollupRecords reuses these seeded entries and adds to them.
    for (const a of AREAS) acc.byArea[a] = blankCounts();
    const jkAcc = { byJk: {}, areas: new Set() };
    const sAcc = { bySession: {}, areas: new Set() };
    const sHealth = { notInSession: 0, needsRerun: 0 };
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      rollupRecords(records, acc);
      rollupByJk(records, jkAcc);
      if (sessions.length) {
        rollupBySession(records, sIds, sAcc);
        sessionHealth(records, sessions, isAcceptedVolunteer, sHealth);
      }
    }
    const rows = rowsFromByArea(acc.byArea);
    const totals = acc.totals;
    const jkAreas = [...jkAcc.areas].sort();
    const jk = jkGrid(jkAcc.byJk, jkAreas);
    // Session grid: area rows x session columns (few sessions, many areas).
    const sessMeta = sessions.map(s => ({ id: String(s.id), name: s.name }));
    const sg = sessions.length ? sessionGrid(sAcc.bySession, sessMeta, [...sAcc.areas]) : { rows: [], colTotals: {}, grand: 0 };
    context.res = { body: { region: scopeRegions.includes(qRegion) ? qRegion : "All", regions: scopeRegions, rows, totals,
      jkAreas, jkRows: jk.rows, jkColTotals: jk.colTotals, jkGrand: jk.grand,
      sessions: sessMeta, sessionRows: sg.rows, sessionColTotals: sg.colTotals, sessionGrand: sg.grand,
      sessionHealth: sHealth } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
