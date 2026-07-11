// De-duplication RESOLUTION (the write path for Build B). Takes an operator's decision for ONE
// cluster and folds the losers into the chosen survivor via retireInto. Superadmin only. Dry-run by
// default — a real write requires commit:true.
//
// SAFETY (layered):
//  - BI membership guard: reads the cached BI id-set (api/biidset). retireInto refuses to merge two
//    records that are BOTH still live in Better Impact. This endpoint additionally REFUSES to touch a
//    cluster containing 2+ Better-Impact ids unless a FRESH id-set snapshot is present (default: <=120
//    min old), because merging numeric-into-numeric with a stale/absent id-set could silently combine
//    two live accounts. Write-in-only and single-BI-id clusters need no snapshot.
//  - Dry-run default: nothing writes unless commit:true.
//  - Reversibility: retireInto records merged_from on the survivor, so every fold is traceable.
//  - The operator is expected to have taken a backup (the UI takes one and sets backedUp:true).
//
// POST body:
//   {
//     region, survivorId, loserIds: [...],
//     winner?: "survivor" | "loser",     // cluster-wide work-block winner on conflict (per-loser default: most progress)
//     keepAcceptanceOf?: "<id>",         // when 2+ members are Accepted, the id whose acceptance STANDS. Its fold
//                                        //   wins ("loser") and every other fold loses ("survivor"), so exactly one
//                                        //   acceptance survives regardless of cluster size. Overrides `winner`.
//     commit?: bool,                      // default false (dry-run)
//     backedUp?: bool                     // the UI asserts a backup was just taken
//   }
const { getContainer, readRegion, retireInto, mergeRecords, REGIONS, streamToString } = require("../shared/store");

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
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const body = req.body || {};
    const region = String(body.region || "");
    const survivorId = body.survivorId != null ? String(body.survivorId) : "";
    const loserIds = Array.isArray(body.loserIds) ? body.loserIds.map(String).filter(id => id && id !== survivorId) : [];
    const commit = body.commit === true;
    // When 2+ members accepted, keepAcceptanceOf names the id whose acceptance survives. It resolves the
    // both-accepted refusal by handing each fold an explicit winner: the kept id's fold wins ("loser" side),
    // all others lose ("survivor" side). Absent -> fall back to the cluster-wide body.winner (or none).
    const keepAcceptanceOf = body.keepAcceptanceOf != null ? String(body.keepAcceptanceOf) : null;
    if (!REGIONS.includes(region)) { context.res = { status: 400, body: { error: "Unknown region." } }; return; }
    if (!survivorId || !loserIds.length) { context.res = { status: 400, body: { error: "Provide survivorId and at least one loserId." } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    // Load the region once to reason about the cluster before touching anything.
    const { records } = await readRegion(container, region);
    const byId = new Map(records.map(r => [String(r.user_id), r]));
    const survivor = byId.get(survivorId);
    if (!survivor) { context.res = { status: 404, body: { error: "Survivor not found in region." } }; return; }
    const missing = loserIds.filter(id => !byId.has(id));
    if (missing.length) { context.res = { status: 404, body: { error: "Loser(s) not found: " + missing.join(", ") } }; return; }

    // BI membership: how many ids in this cluster are Better-Impact (numeric) accounts?
    const clusterIds = [survivorId, ...loserIds];
    const numericIds = clusterIds.filter(id => !isWritein(id));
    const snap = await readBiSnapshot(container);
    const snapAgeMin = snap ? Math.round((Date.now() - new Date(snap.fetchedAt).getTime()) / 60000) : null;
    const snapFresh = snap && snapAgeMin != null && snapAgeMin <= SNAPSHOT_MAX_AGE_MIN;
    const biIds = new Set(snap ? (snap.ids || []).map(String) : []);

    // Guard: 2+ BI ids require a FRESH snapshot, or we cannot safely tell live-vs-orphan.
    if (numericIds.length >= 2 && !snapFresh) {
      context.res = { status: 409, body: {
        error: "This group has 2+ Better Impact accounts and needs a fresh BI id-set before it can be resolved.",
        need: "refresh_bi_idset",
        snapshotAgeMinutes: snapAgeMin, maxAgeMinutes: SNAPSHOT_MAX_AGE_MIN,
      } }; return; }

    // Determine BI-liveness for reporting + set-aside decisions.
    const liveInBi = numericIds.filter(id => biIds.has(id));
    // If the SURVIVOR and any LOSER are both live BI accounts, retireInto will refuse that pair — surface
    // it as "must be resolved in Better Impact" rather than attempting the merge.
    const bothLivePairs = loserIds
      .filter(id => !isWritein(id) && biIds.has(id) && !isWritein(survivorId) && biIds.has(survivorId));

    // Build the plan: fold each loser into the survivor in turn. Dry-run computes the outcome with the
    // pure mergeRecords; commit performs it with retireInto (which persists + re-buckets).
    const opts = { biIds, actor: email || "dedupresolve" };
    // Per-loser winner: if a kept acceptance is named, that fold wins and the rest lose; else the
    // cluster-wide body.winner (usually undefined -> most-progress default inside mergeRecords).
    const winnerFor = (lid) => keepAcceptanceOf != null
      ? (String(lid) === keepAcceptanceOf ? "loser" : "survivor")
      : body.winner;
    const results = [];
    if (!commit) {
      // DRY RUN: simulate sequentially against an in-memory copy so multi-loser folds are realistic.
      let workingSurvivor = { ...survivor };
      for (const lid of loserIds) {
        const loser = byId.get(lid);
        const m = mergeRecords(loser, workingSurvivor, { ...opts, winner: winnerFor(lid) });
        results.push({ loserId: lid, ok: m.ok, reason: m.reason || null,
          bothInBi: m.reason === "both_in_bi", needsWinner: m.reason === "both_accepted_needs_winner" });
        if (m.ok) workingSurvivor = m.record;   // chain: next loser folds into the growing survivor
      }
      context.res = { body: {
        mode: "dry-run", region, survivorId, loserIds,
        biSnapshot: snap ? { ageMinutes: snapAgeMin, fresh: snapFresh, count: biIds.size } : null,
        numericIdCount: numericIds.length, liveInBiCount: liveInBi.length,
        setAsideForBiTeam: bothLivePairs.length > 0,
        results,
        survivorPreview: results.every(r => r.ok || r.bothInBi) ? {
          user_id: workingSurvivor.user_id, final_area: workingSurvivor.final_area,
          accepted: !!(workingSurvivor.ivol_ready || String(workingSurvivor.call_outcome).toLowerCase() === "accepted"),
          merged_from: workingSurvivor.merged_from || [],
        } : null,
      } };
      return;
    }

    // COMMIT: refuse if a backup wasn't asserted (the UI takes one first).
    if (body.backedUp !== true) {
      context.res = { status: 428, body: { error: "Take a backup first, then retry. (backedUp flag not set.)", need: "backup" } };
      return;
    }
    // Perform folds one at a time. Each retireInto is its own atomic region merge; if one refuses
    // (both_in_bi / needs winner), we record it and continue with the rest.
    for (const lid of loserIds) {
      const r = await retireInto(container, region, lid, survivorId, { ...opts, winner: winnerFor(lid) });
      results.push({ loserId: lid, ...r, bothInBi: r.reason === "both_in_bi", needsWinner: r.reason === "both_accepted_needs_winner" });
    }
    context.res = { body: {
      mode: "commit", region, survivorId,
      merged: results.filter(r => r.ok).length,
      refused: results.filter(r => !r.ok).length,
      results,
    } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
