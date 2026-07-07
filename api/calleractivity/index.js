// Caller Activity: for every caller in the viewer's area/region, how many volunteers are assigned to
// them, completed, and pending, plus when they were last active. Counts are scoped to the viewer's
// own areas/regions. Super Admin & Leadership see all; Admin & Duty Team see their event regions;
// Quarterbacks see only their area×region.
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const clean = (s) => String(s == null ? "" : s).trim();

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const scopesFor = (store, email, role) => store
  .filter(a => clean(a.email).toLowerCase() === email && clean(a.role) === role && clean(a.area))
  .map(a => ({ area: clean(a.area), region: clean(a.region) }));
const inScope = (scopes, area, region) => scopes.some(s => s.area === area && s.region === region);

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const ALLOWED = ["superadmin", "admin", "dutyteam", "quarterback", "leadership"];
    if (!email || !roles.some(r => ALLOWED.includes(r))) { context.res = { status: 403, body: { error: "Not authorized for this view." } }; return; }

    const store = await readRolesStore();
    const seeAll = roles.includes("superadmin") || roles.includes("leadership");
    let regionScope = null;   // admin/dutyteam
    let qbScopes = [];        // quarterback
    if (!seeAll) {
      if (roles.includes("admin") || roles.includes("dutyteam")) regionScope = new Set(allowedRegionsFor(store, email));
      if (roles.includes("quarterback")) qbScopes = scopesFor(store, email, "quarterback");
    }
    const volInScope = (v) => {
      if (seeAll) return true;
      if (regionScope && regionScope.has(v.region)) return true;
      if (qbScopes.length && inScope(qbScopes, v.final_area, v.region)) return true;
      return false;
    };
    // A caller role-entry (area×region) is in the viewer's scope?
    const callerScopeVisible = (a, r) => {
      if (seeAll) return true;
      if (regionScope && regionScope.has(r)) return true;
      if (qbScopes.length && inScope(qbScopes, a, r)) return true;
      return false;
    };

    // Build the caller roster within scope: email -> { areas:Set, regions:Set }.
    const callers = new Map();
    for (const a of store) {
      if (clean(a.role) !== "caller") continue;
      const ce = clean(a.email).toLowerCase(), ar = clean(a.area), rg = clean(a.region);
      if (!ce || !callerScopeVisible(ar, rg)) continue;
      const c = callers.get(ce) || { email: ce, areas: new Set(), regions: new Set(), assigned: 0, completed: 0, pending: 0, lastActive: null };
      if (ar) c.areas.add(ar); if (rg) c.regions.add(rg);
      callers.set(ce, c);
    }

    // One pass over in-scope volunteers: tally assignments and last-active per caller.
    const regions = seeAll ? REGIONS : REGIONS.filter(r => (regionScope && regionScope.has(r)) || qbScopes.some(s => s.region === r));
    const container = await getContainer(DATA_CONTAINER);
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        if (!volInScope(v)) continue;
        const ac = clean(v.assigned_caller).toLowerCase();
        if (ac && callers.has(ac)) {
          const c = callers.get(ac);
          c.assigned++;
          if (v.call_done) c.completed++; else c.pending++;
        }
        for (const e of (v.activity_log || [])) {
          const actor = clean(e && e.actor).toLowerCase();
          if (actor && callers.has(actor) && e.ts) {
            const c = callers.get(actor);
            if (!c.lastActive || e.ts > c.lastActive) c.lastActive = e.ts;
          }
        }
      }
    }

    const rows = [...callers.values()].map(c => ({
      email: c.email, areas: [...c.areas].sort(), regions: [...c.regions].sort(),
      assigned: c.assigned, completed: c.completed, pending: c.pending, lastActive: c.lastActive,
    })).sort((a, b) => a.email.localeCompare(b.email));

    context.res = { body: { callers: rows, count: rows.length } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
