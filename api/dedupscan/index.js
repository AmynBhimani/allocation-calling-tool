// READ-ONLY internal duplicate scan (Build A2). Finds records that are likely the SAME human inside
// the allocation tool, ignoring Better Impact entirely. It NEVER writes — resolution happens in the
// separate resolution screen (Build B) via retireInto, which also does the live-BI membership check.
//
// Aggressive by design: recall over precision. A false cluster costs a glance; a missed duplicate
// costs a double-counted volunteer. Clusters are categorized so the operator knows what needs a BI
// pull before it can be merged:
//   accepted_multi_area -> DANGER: the same person is accepted in 2+ different areas (double count)
//   needs_bi_check       -> 2+ Better-Impact ids in the cluster; a fresh BI pull is needed to know
//                           whether both still exist in BI (-> BI team resolves) or one is an orphan
//   mergeable            -> at most one BI id (rest are write-ins); safe to fold in Build B
//
//   /api/dedupscan                      -> all regions the caller may see
//   /api/dedupscan?region=Prairies      -> one region
//   /api/dedupscan?category=accepted_multi_area   -> only that bucket
//   /api/dedupscan?min=medium           -> only clusters at/above a confidence (low|medium|high)
//
// Superadmin / admin only. Admin is walled to their event regions. Writes nothing, ever.
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { findDuplicateClusters } = require("../shared/dedup");

const CONN = process.env.RESPONSES_STORAGE;

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const emailOf = (p) => {
  if (!p) return null;
  let e = p.userDetails || null;
  if (!e && Array.isArray(p.claims)) {
    const c = p.claims.find(c => /(emailaddress|email|preferred_username|upn)$/i.test(c.typ || c.type || ""));
    if (c) e = c.val || c.value;
  }
  return e ? String(e).toLowerCase() : null;
};

module.exports = async function (context, req) {
  try {
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }
    const p = getPrincipal(req);
    const roles = (p && p.userRoles) || [];
    const email = emailOf(p);
    const isSuper = roles.includes("superadmin");
    const isAdmin = roles.includes("admin");
    if (!(isSuper || isAdmin)) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }

    // Region scope: superadmin sees all; admin is walled to their assigned event regions.
    let regions = REGIONS.slice();
    if (!isSuper) {
      const allowed = allowedRegionsFor(await readRolesStore(), email) || [];
      regions = regions.filter(r => allowed.includes(r));
    }
    const wantRegion = (req.query.region || "").trim();
    if (wantRegion) regions = regions.filter(r => r === wantRegion);
    if (!regions.length) { context.res = { body: { clusters: [], stats: { scanned: 0, clusters: 0 }, regions: [] } }; return; }

    // Read the requested regions and scan each independently (a duplicate pair always shares a region,
    // since a person's region is derived from their JK — cross-region pairs are not real duplicates).
    const container = await getContainer();
    let allClusters = [];
    const perRegion = {};
    let scanned = 0;
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      scanned += records.length;
      const { clusters, stats } = findDuplicateClusters(records);
      perRegion[region] = stats;
      for (const c of clusters) { c.region = region; allClusters.push(c); }
    }

    // Optional filters.
    const cat = (req.query.category || "").trim();
    if (cat) allClusters = allClusters.filter(c => c.category === cat);
    const min = (req.query.min || "").trim().toLowerCase();
    if (["low", "medium", "high"].includes(min)) {
      const rank = { low: 1, medium: 2, high: 3 };
      allClusters = allClusters.filter(c => rank[c.topConfidence] >= rank[min]);
    }

    // Global sort: danger first, then confidence, then size.
    const catRank = { accepted_multi_area: 3, needs_bi_check: 2, mergeable: 1 };
    const confRank = { high: 3, medium: 2, low: 1 };
    allClusters.sort((a, b) =>
      (catRank[b.category] - catRank[a.category]) ||
      (confRank[b.topConfidence] - confRank[a.topConfidence]) ||
      (b.size - a.size));

    const stats = {
      scanned,
      clusters: allClusters.length,
      duplicateRecords: allClusters.reduce((s, c) => s + c.size, 0),
      accepted_multi_area: allClusters.filter(c => c.category === "accepted_multi_area").length,
      needs_bi_check: allClusters.filter(c => c.category === "needs_bi_check").length,
      mergeable: allClusters.filter(c => c.category === "mergeable").length,
    };
    context.res = { body: { clusters: allClusters.slice(0, 2000), stats, regions, perRegion } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
