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
const { planReassign, applyReassign, DEFAULT_FROM, DEFAULT_TARGETS } = require("../shared/reassign");

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

    const from = DEFAULT_FROM, targets = DEFAULT_TARGETS;
    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = (region) => isSuper || (allowed && allowed.includes(region));
    const scopeRegions = REGIONS.filter(inScope);
    const container = await getContainer(DATA_CONTAINER);

    // ---- GET: dry run ----
    if (String(req.method || "").toUpperCase() !== "POST") {
      const counts = {}; targets.forEach(t => { counts[t] = 0; });
      const byReason = { interest: 0, balanced: 0 };
      const byRegion = {}; let total = 0; const sample = [];
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        const p = planReassign(records, { from, targets });
        byRegion[region] = { total: p.count, counts: p.counts };
        total += p.count;
        targets.forEach(t => { counts[t] += p.counts[t]; });
        byReason.interest += p.byReason.interest; byReason.balanced += p.byReason.balanced;
        for (const row of p.plan.slice(0, SAMPLE_PER_REGION)) sample.push(row);
      }
      context.res = { body: { mode: "dry-run", from, targets, total, counts, byReason, byRegion, sample } };
      return;
    }

    // ---- POST: commit ----
    const nowIso = new Date().toISOString();
    const counts = {}; targets.forEach(t => { counts[t] = 0; });
    const byRegion = {}; let movedCount = 0;
    for (const region of scopeRegions) {
      let n = 0; const rCounts = {}; targets.forEach(t => { rCounts[t] = 0; });
      await mergeRegion(container, region, (records) => {
        const p = planReassign(records, { from, targets });
        const byId = new Map(p.plan.map(x => [String(x.user_id), x.to]));
        for (const v of records) {
          const to = byId.get(String(v.user_id));
          if (to) { applyReassign(v, to, from, email, nowIso); n++; rCounts[to]++; }
        }
        return records;
      });
      byRegion[region] = { total: n, counts: rCounts };
      targets.forEach(t => { counts[t] += rCounts[t]; });
      movedCount += n;
    }
    context.res = { body: { ok: true, mode: "commit", from, movedCount, counts, byRegion } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
