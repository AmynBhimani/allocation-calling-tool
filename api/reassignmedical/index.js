// Reassign everyone out of Medical Services (being dissolved) into Safety & Flow / Seniors & Mobility /
// Reception & Hospitality, balanced per region, honouring pref_areas. Run this BEFORE the mass-accept so
// people are accepted into — and emailed about — their new area, not Medical.
//   GET  -> DRY RUN: the plan, with the resulting split per target (overall + per region) and how many
//           were placed by interest vs. to balance. Writes nothing.
//   POST -> COMMIT: apply the moves (one safe merge-write per region). Re-running is safe — once moved,
//           nobody is still in Medical Services, so a second pass is a no-op.
// Super Admin / Admin only; Admin is region-walled. Balancing is per region because areas are staffed
// within a region's Didar.
const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { planReassign, applyReassign, DEFAULT_FROM, DEFAULT_TARGETS, OVERFLOW_AREA } = require("../shared/reassign");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const SAMPLE_PER_REGION = 20;

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
    if (!email || !(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const from = DEFAULT_FROM;
    const areas = [...DEFAULT_TARGETS, OVERFLOW_AREA];   // the four landing areas (3 targets + overflow)
    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = (region) => isSuper || (allowed && allowed.includes(region));
    const scopeRegions = REGIONS.filter(inScope);
    const container = await getContainer(DATA_CONTAINER);

    // ---- GET: dry run ----
    if (String(req.method || "").toUpperCase() !== "POST") {
      const counts = {}; areas.forEach(a => { counts[a] = 0; });
      const byReason = { interest: 0, balanced: 0, overflow: 0 };
      const byRegion = {}; let total = 0, kept = 0, keptAccepted = 0, keptLineup = 0; const sample = []; const keptSample = [];
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        const p = planReassign(records, { keepCommitted: true });
        byRegion[region] = { total: p.count, kept: p.kept, counts: p.counts };
        total += p.count;
        for (const k of Object.keys(p.counts)) counts[k] = (counts[k] || 0) + p.counts[k];
        for (const k of Object.keys(p.byReason)) byReason[k] = (byReason[k] || 0) + p.byReason[k];
        for (const row of p.plan.slice(0, SAMPLE_PER_REGION)) sample.push(row);
        kept += p.kept; keptAccepted += p.keptAccepted; keptLineup += p.keptLineup;
        for (const row of (p.keptSample || [])) keptSample.push(row);
      }
      context.res = { body: { mode: "dry-run", from, areas, overflow: OVERFLOW_AREA, total, kept, keptAccepted, keptLineup, counts, byReason, byRegion, sample, keptSample } };
      return;
    }

    // ---- POST: commit ----
    // Counting is retry-safe: mergeRegion re-runs the closure on a write conflict, so the plan's own
    // count is captured INSIDE the closure and overwritten each run — the last (successful) run wins.
    const nowIso = new Date().toISOString();
    const counts = {}; areas.forEach(a => { counts[a] = 0; });
    const byRegion = {}; let movedCount = 0, keptTotal = 0;
    for (const region of scopeRegions) {
      let regionCount = 0, regionCounts = {};
      await mergeRegion(container, region, (records) => {
        const p = planReassign(records, { keepCommitted: true });
        const byId = new Map(p.plan.map(x => [String(x.user_id), x.to]));
        for (const v of records) {
          const to = byId.get(String(v.user_id));
          if (to) applyReassign(v, to, from, email, nowIso);
        }
        regionCount = p.count; regionCounts = p.counts; regionKept = p.kept;
        return records;
      });
      byRegion[region] = { total: regionCount, kept: regionKept, counts: regionCounts };
      keptTotal += regionKept;
      for (const k of Object.keys(regionCounts)) counts[k] = (counts[k] || 0) + regionCounts[k];
      movedCount += regionCount;
    }
    context.res = { body: { ok: true, mode: "commit", from, movedCount, keptTotal, counts, byRegion } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
