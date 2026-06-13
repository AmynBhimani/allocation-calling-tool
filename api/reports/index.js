const { getContainer, readRegion, REGIONS } = require("../shared/store");

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

    const qRegion = String(req.query.region || "").trim();
    const regions = REGIONS.includes(qRegion) ? [qRegion] : REGIONS;
    const container = await getContainer(DATA_CONTAINER);

    const byArea = {};
    const blank = () => ({ inPool: 0, assigned: 0, called: 0, accepted: 0, declined: 0, withdrew: 0, pending: 0 });
    const totals = blank();

    for (const region of regions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        // only the callable pipeline (excludes Leadership-do-not-allocate / not-yet-callable)
        if (v.callable_status === "Leadership - Do Not Allocate") continue;
        const area = v.final_area || "(no area)";
        const b = byArea[area] || (byArea[area] = blank());
        const lo = lastOutcome(v);
        b.inPool++; totals.inPool++;

        // A person who declined and was referred elsewhere: the decline belongs to the area
        // they left (referred_from), and in their new area they're a fresh, not-yet-called prospect.
        if (lo === "Declined-referred" && v.referred_from) {
          const da = byArea[v.referred_from] || (byArea[v.referred_from] = blank());
          da.called++; da.declined++; totals.called++; totals.declined++;
          if (v.assigned_caller) { b.assigned++; totals.assigned++; b.pending++; totals.pending++; }
          continue;
        }

        const isAssigned = !!v.assigned_caller;
        const isAccepted = !!v.ivol_ready || lo === "Accepted";
        const isDeclined = lo === "Declined-referred";   // declined with no referral recorded
        const isWithdrew = lo === "Withdrew";
        const isCalled = lo != null;

        if (isAssigned) { b.assigned++; totals.assigned++; }
        if (isCalled) { b.called++; totals.called++; }
        if (isAccepted) { b.accepted++; totals.accepted++; }
        if (isDeclined) { b.declined++; totals.declined++; }
        if (isWithdrew) { b.withdrew++; totals.withdrew++; }
        if (isAssigned && !isCalled) { b.pending++; totals.pending++; }
      }
    }

    const rows = Object.keys(byArea).sort().map(area => ({ area, ...byArea[area] }));
    context.res = { body: { region: REGIONS.includes(qRegion) ? qRegion : "All", regions: REGIONS, rows, totals } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
