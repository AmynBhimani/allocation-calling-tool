// Event wrap-up mass-accept. Calling has stopped; this sweeps every assigned-but-not-accepted volunteer
// in scope and sorts them into buckets (see shared/wrapup):
//   GET  -> DRY RUN: classify everyone, return per-bucket totals + per-area breakdown + a sample, and the
//           skip reasons. Writes nothing. This is the gate: review it before committing.
//   POST -> COMMIT: accept ONLY the "accept" bucket (one safe merge-write per region). Unreached people
//           are left un-accepted for the No-Response email; Withdrew/Duplicate are left alone. Re-running
//           is safe — already-accepted people re-classify out of the accept bucket.
// Super Admin / Admin only; Admin is region-walled. Accept state matches api/bulkaccept exactly.
const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { classify, applyAccept } = require("../shared/wrapup");
const { AREAS } = require("../shared/duties");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const SAMPLE_PER_BUCKET = 40;

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const nm = (v) => ((v.first || "") + " " + (v.last || "")).trim() || ("#" + v.user_id);
const areaOf = (v) => v.final_area || "(no area)";

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
    if (!email || !(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = (region) => isSuper || (allowed && allowed.includes(region));
    const scopeRegions = REGIONS.filter(inScope);
    const container = await getContainer(DATA_CONTAINER);

    // Optional filters (same source for GET preview and POST commit, so the commit accepts exactly what
    // the filtered preview showed). Area is matched on final_area; region narrows within the caller's
    // own scope. The area dropdown is the full configured list, so a newly-added area (e.g. Volunteer
    // Engagement) is always selectable even before anyone is accepted into it.
    const src = req.body || {};
    const q = req.query || {};
    const areaFilter = String(q.area || src.area || "").trim();
    const regionFilter = String(q.region || src.region || "").trim();
    const regionsToScan = (regionFilter && scopeRegions.includes(regionFilter)) ? [regionFilter] : scopeRegions;
    const matchesArea = (v) => !areaFilter || (v.final_area || "(no area)") === areaFilter;

    // ---- GET: dry run ----
    if (String(req.method || "").toUpperCase() !== "POST") {
      const mk = () => ({ total: 0, byArea: {}, sample: [] });
      const buckets = { accept: mk(), unreached: mk(), leaveAlone: mk() };
      const skipped = { leadership: 0, alreadyAccepted: 0, noArea: 0, inReconciliation: 0, notAssignable: 0 };
      for (const region of regionsToScan) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          if (!matchesArea(v)) continue;
          const b = classify(v);
          if (buckets[b]) {
            const bk = buckets[b], a = areaOf(v);
            bk.total++; bk.byArea[a] = (bk.byArea[a] || 0) + 1;
            if (bk.sample.length < SAMPLE_PER_BUCKET) bk.sample.push({ name: nm(v), area: a, region, call_outcome: v.call_outcome || "" });
          } else if (b in skipped) { skipped[b]++; }
        }
      }
      context.res = { body: { mode: "dry-run", scope: regionsToScan, regions: scopeRegions, areas: [...AREAS].sort(),
        filter: { area: areaFilter || null, region: regionFilter || null }, buckets, skipped } };
      return;
    }

    // ---- POST: commit (accept the accept-bucket only) ----
    const nowIso = new Date().toISOString();
    let acceptedCount = 0;
    const byRegion = {}, byArea = {};
    for (const region of regionsToScan) {
      let n = 0;
      await mergeRegion(container, region, (records) => {
        for (const v of records) {
          if (!matchesArea(v)) continue;
          if (classify(v) === "accept") {
            applyAccept(v, email, nowIso);
            n++; const a = areaOf(v); byArea[a] = (byArea[a] || 0) + 1;
          }
        }
        return records;
      });
      byRegion[region] = n; acceptedCount += n;
    }
    context.res = { body: { ok: true, mode: "commit", acceptedCount, byRegion, byArea,
      filter: { area: areaFilter || null, region: regionFilter || null } } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
