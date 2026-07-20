// Restore everyone the Medical Services reassignment moved back into Medical Services. Identifies them by
// the "area_reassigned" marker the reassignment stamped, and reverses ONLY what it changed (final_area +
// the matching row areas) — so accepted status, assigned duty, lineup state, and confirmation are all
// preserved. Fixes the case where volunteers who had already accepted a Medical duty were split out.
//   GET  -> DRY RUN: who would be restored, from which areas, and how many had accepted. Writes nothing.
//   POST -> COMMIT: restore them (one safe merge-write per region). Re-running is safe — once back in
//           Medical Services, a person is skipped.
// Super Admin / Admin only; Admin is region-walled.
const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { planRestore, applyRestore, DEFAULT_FROM } = require("../shared/reassign");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const SAMPLE_PER_REGION = 25;

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
    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = (region) => isSuper || (allowed && allowed.includes(region));
    const scopeRegions = REGIONS.filter(inScope);
    const container = await getContainer(DATA_CONTAINER);

    // ---- GET: dry run ----
    if (String(req.method || "").toUpperCase() !== "POST") {
      let total = 0, accepted = 0; const byArea = {}; const byRegion = {}; const sample = [];
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        const p = planRestore(records, { from });
        byRegion[region] = { total: p.count, accepted: p.accepted };
        total += p.count; accepted += p.accepted;
        for (const k of Object.keys(p.byArea)) byArea[k] = (byArea[k] || 0) + p.byArea[k];
        for (const row of p.plan.slice(0, SAMPLE_PER_REGION)) sample.push(row);
      }
      context.res = { body: { mode: "dry-run", from, total, accepted, byArea, byRegion, sample } };
      return;
    }

    // ---- POST: commit ----
    // Retry-safe: mergeRegion re-runs the closure on a write conflict, so the plan's count is captured
    // inside the closure and overwritten each run — the last (successful) run wins.
    const nowIso = new Date().toISOString();
    let restored = 0; const byRegion = {};
    for (const region of scopeRegions) {
      let regionCount = 0;
      await mergeRegion(container, region, (records) => {
        const p = planRestore(records, { from });
        const ids = new Set(p.plan.map(x => String(x.user_id)));
        for (const v of records) { if (ids.has(String(v.user_id))) applyRestore(v, from, email, nowIso); }
        regionCount = p.count;
        return records;
      });
      byRegion[region] = regionCount;
      restored += regionCount;
    }
    context.res = { body: { ok: true, mode: "commit", from, restored, byRegion } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
