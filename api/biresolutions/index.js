// READ-ONLY list of duplicate groups where 2+ Better Impact accounts are BOTH still live — exactly the
// pairs the app refuses to merge (both_in_bi) and that the BI team must resolve upstream in Better
// Impact. Crosses the internal duplicate scan against the cached BI id-set snapshot; writes nothing.
// Visible to Super Admin, Admin (region-walled), and iVol Admin (the BI team's role).
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor, streamToString } = require("../shared/store");
const { findDuplicateClusters } = require("../shared/dedup");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const SNAPSHOT_BLOB = "bi-idset-snapshot.json";
const SNAPSHOT_MAX_AGE_MIN = Number(process.env.BI_SNAPSHOT_MAX_AGE_MIN || 120);

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
async function readBiSnapshot(container) {
  try {
    const b = container.getBlockBlobClient(SNAPSHOT_BLOB);
    if (!(await b.exists())) return null;
    return JSON.parse(await streamToString((await b.download()).readableStreamBody));
  } catch { return null; }
}
const isWritein = (id) => String(id).startsWith("wi-");

module.exports = async function (context, req) {
  try {
    const p = getPrincipal(req);
    const roles = (p && p.userRoles) || [];
    const email = emailOf(p);
    const isSuper = roles.includes("superadmin");
    const isIvol = roles.includes("ivoladmin");
    const isAdmin = roles.includes("admin");
    if (!(isSuper || isAdmin || isIvol)) { context.res = { status: 403, body: { error: "Super Admin, Admin, or iVol Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }
    const container = await getContainer(DATA_CONTAINER);

    // The BI snapshot is the liveness source. Without it we cannot tell a live account from an orphan.
    const snap = await readBiSnapshot(container);
    if (!snap) { context.res = { body: { present: false } }; return; }
    const ageMinutes = Math.round((Date.now() - new Date(snap.fetchedAt).getTime()) / 60000);
    const fresh = ageMinutes <= SNAPSHOT_MAX_AGE_MIN;
    const biIds = new Set((snap.ids || []).map(String));

    // Region scope: superadmin + ivoladmin see all; admin is walled to their event regions.
    let regions = REGIONS.slice();
    if (!(isSuper || isIvol)) {
      const allowed = allowedRegionsFor(await readRolesStore(), email) || [];
      regions = regions.filter(r => allowed.includes(r));
    }
    const wantRegion = (req.query.region || "").trim();
    if (wantRegion) regions = regions.filter(r => r === wantRegion);

    const groups = [];
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      const { clusters } = findDuplicateClusters(records);
      for (const c of clusters) {
        // Live-in-BI members = numeric (BI) ids present in the snapshot. 0 or 1 live -> resolvable in the
        // app (fold the orphan), so it is NOT a BI-team case; only 2+ live accounts go to Better Impact.
        const live = c.members.filter(m => !isWritein(m.user_id) && biIds.has(String(m.user_id)));
        if (live.length < 2) continue;
        groups.push({
          region, topConfidence: c.topConfidence, signals: c.signals,
          acceptedInMultipleAreas: !!c.acceptedInMultipleAreas, liveCount: live.length,
          members: live.map(m => ({
            user_id: m.user_id, name: m.name, ceremony_jk: m.ceremony_jk, final_area: m.final_area,
            accepted: m.accepted, assigned_caller: m.assigned_caller, email: m.email, cell_phone: m.cell_phone,
          })),
        });
      }
    }
    const confRank = { high: 3, medium: 2, low: 1 };
    groups.sort((a, b) =>
      (Number(b.acceptedInMultipleAreas) - Number(a.acceptedInMultipleAreas)) ||
      (confRank[b.topConfidence] - confRank[a.topConfidence]) ||
      (b.liveCount - a.liveCount));

    context.res = { body: {
      present: true, fetchedAt: snap.fetchedAt, ageMinutes, fresh, biCount: biIds.size, regions,
      groups: groups.slice(0, 2000),
      stats: { groups: groups.length, accounts: groups.reduce((s, g) => s + g.liveCount, 0),
        doubleCounted: groups.filter(g => g.acceptedInMultipleAreas).length },
    } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
