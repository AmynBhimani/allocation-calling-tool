// Duplicate groups where 2+ Better Impact accounts are BOTH still live — the pairs the app refuses to
// merge on its own (both_in_bi). GET lists them.
//
// POST lets the iVol admin resolve one in the app as they resolve it in Better Impact. They must DECLARE
// which BI account they are keeping (biKeep); that is precisely the fact the both_in_bi rule is missing,
// so naming it satisfies the rule (a generic "force" is still refused — see mergeRecords).
//
// ORDER MATTERS, and the response says so: biupsert re-creates a record for any live BI account it can't
// find, so if the duplicate has NOT been removed in Better Impact it will come back on the next refresh.
// We warn rather than block: the snapshot can be two hours stale and the iVol admin is the one doing the
// upstream merge — blocking on a stale snapshot would stop real work for a fact we can't verify anyway.
// READ-ONLY list of duplicate groups where 2+ Better Impact accounts are BOTH still live — exactly the
// pairs the app refuses to merge (both_in_bi) and that the BI team must resolve upstream in Better
// Impact. Crosses the internal duplicate scan against the cached BI id-set snapshot; writes nothing.
// Visible to Super Admin, Admin (region-walled), and iVol Admin (the BI team's role).
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor, streamToString, retireInto, mergeRecords } = require("../shared/store");
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
    // ---- Resolve one group in the app (iVol admin mirroring their Better Impact merge) ----
    if (req.method === "POST") {
      const body = req.body || {};
      const region = String(body.region || "").trim();
      const survivorId = String(body.survivorId || "").trim();
      const loserIds = [...new Set((Array.isArray(body.loserIds) ? body.loserIds : []).map(String).filter(Boolean))];
      const biKeep = String(body.biKeep || "").trim();
      const commit = !!body.commit;
      const winner = body.winner === "loser" || body.winner === "survivor" ? body.winner : undefined;

      if (!regions.includes(region)) { context.res = { status: 403, body: { error: "That region isn't in your scope." } }; return; }
      if (!survivorId || !loserIds.length) { context.res = { status: 400, body: { error: "Choose the profile to keep and at least one to merge in." } }; return; }
      if (loserIds.includes(survivorId)) { context.res = { status: 400, body: { error: "The profile being kept can't also be merged in." } }; return; }
      // The declaration is the whole basis for overriding both_in_bi — it must name the survivor.
      if (!biKeep || biKeep !== survivorId) { context.res = { status: 400, body: { error: "Declare which Better Impact account you're keeping; it must be the profile you selected." } }; return; }

      const { records } = await readRegion(container, region);
      const survivor = records.find(r => String(r.user_id) === survivorId);
      if (!survivor) { context.res = { status: 404, body: { error: "The profile being kept wasn't found in that region." } }; return; }
      const missing = loserIds.filter(id => !records.find(r => String(r.user_id) === id));
      if (missing.length) { context.res = { status: 404, body: { error: "Not found: " + missing.join(", ") } }; return; }

      const opts = { biIds, biKeep, winner, actor: email || "biresolutions" };
      // Which of these are still live in Better Impact per the snapshot? Almost always all of them —
      // that's the point of this screen — so the answer is a warning, not a block.
      const stillLive = loserIds.filter(id => biIds.has(String(id)));

      if (!commit) {
        const results = loserIds.map(id => {
          const m = mergeRecords(records.find(r => String(r.user_id) === id), survivor, opts);   // pure dry-run
          return { loserId: id, ok: !!m.ok, reason: m.reason || null,
            needsWinner: m.reason === "both_accepted_needs_winner", bothInBi: m.reason === "both_in_bi" };
        });
        context.res = { body: { mode: "preview", region, survivorId, loserIds, results,
          stillLiveInBi: stillLive, ageMinutes, fresh,
          note: stillLive.length
            ? "Better Impact still lists " + stillLive.length + " of these as live (snapshot " + ageMinutes + " min old). If they haven't been removed there, they'll come back on the next refresh."
            : "Better Impact no longer lists these as live \u2014 safe to fold." } };
        return;
      }

      const results = [];
      for (const lid of loserIds) {
        const r = await retireInto(container, region, lid, survivorId, opts);
        results.push({ loserId: lid, ok: !!r.ok, reason: r.reason || null,
          needsWinner: r.reason === "both_accepted_needs_winner", bothInBi: r.reason === "both_in_bi" });
      }
      const merged = results.filter(r => r.ok).length;
      context.res = { body: { mode: "commit", region, survivorId, merged, results, stillLiveInBi: stillLive, ageMinutes,
        note: merged && stillLive.length
          ? "Folded. Remember to remove the duplicate in Better Impact \u2014 otherwise it returns on the next refresh."
          : (merged ? "Folded." : "Nothing was merged \u2014 see the reasons below.") } };
      return;
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
