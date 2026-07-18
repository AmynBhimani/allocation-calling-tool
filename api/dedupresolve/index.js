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
// Accepted, by the same test mergeRecords uses (ivol_ready OR call_outcome === "accepted"). Used only to
// decide whether a same-id fold needs an explicit winner (both accepted) or can take most-progress.
const sameProgressAccepted = (v) => !!(v && (v.ivol_ready || String(v.call_outcome).toLowerCase() === "accepted"));

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
    // Extra records carrying the SURVIVOR'S OWN id (an app copy + a re-imported BI copy). They can't go
    // in loserIds — that list drops anything equal to the survivor id — so they arrive as a count of how
    // many same-id copies to fold. Bounded by how many actually exist, computed once records are loaded.
    const sameIdWanted = Math.max(0, parseInt(body.sameIdCount, 10) || 0);
    const commit = body.commit === true;
    // When 2+ members accepted, keepAcceptanceOf names the id whose acceptance survives. It resolves the
    // both-accepted refusal by handing each fold an explicit winner: the kept id's fold wins ("loser" side),
    // all others lose ("survivor" side). Absent -> fall back to the cluster-wide body.winner (or none).
    const keepAcceptanceOf = body.keepAcceptanceOf != null ? String(body.keepAcceptanceOf) : null;
    if (!REGIONS.includes(region)) { context.res = { status: 400, body: { error: "Unknown region." } }; return; }
    if (!survivorId || (!loserIds.length && sameIdWanted < 1)) { context.res = { status: 400, body: { error: "Provide survivorId and at least one loser (or a same-id duplicate to fold)." } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    // Load the region once to reason about the cluster before touching anything.
    const { records } = await readRegion(container, region);
    const byId = new Map(records.map(r => [String(r.user_id), r]));
    const survivor = byId.get(survivorId);
    if (!survivor) { context.res = { status: 404, body: { error: "Survivor not found in region." } }; return; }
    const missing = loserIds.filter(id => !byId.has(id));
    if (missing.length) { context.res = { status: 404, body: { error: "Loser(s) not found: " + missing.join(", ") } }; return; }
    // The survivor id may appear on several records; all but one are duplicates to fold. Never fold more
    // than exist, never fold the survivor's last remaining copy.
    const sameIdCopies = records.filter(r => String(r.user_id) === survivorId).length - 1;   // extras beyond the survivor
    const sameIdToFold = Math.min(sameIdWanted, Math.max(0, sameIdCopies));

    // BI membership: how many DISTINCT Better-Impact (numeric) accounts are in this cluster? Distinct
    // matters: a duplicate can share ONE BI id across both rows (app copy + re-imported BI copy), which
    // is a single account duplicated in the app — mergeable here, not a two-live-account BI-team case.
    const clusterIds = [survivorId, ...loserIds];
    const numericIds = [...new Set(clusterIds.filter(id => !isWritein(id)))];
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
      .filter(id => !isWritein(id) && biIds.has(id) && !isWritein(survivorId) && biIds.has(survivorId)
        && String(id) !== String(survivorId));   // same id as survivor = same account, not a 2nd live one

    // Build the plan: fold each loser into the survivor in turn. Dry-run computes the outcome with the
    // pure mergeRecords; commit performs it with retireInto (which persists + re-buckets).
    const opts = { biIds, actor: email || "dedupresolve" };
    // Per-loser winner: if a kept acceptance is named, that fold wins and the rest lose; else the
    // cluster-wide body.winner (usually undefined -> most-progress default inside mergeRecords).
    const winnerFor = (lid) => keepAcceptanceOf != null
      ? (String(lid) === keepAcceptanceOf ? "loser" : "survivor")
      : body.winner;
    // Promotion: if the operator kept a WRITE-IN as survivor but exactly one real Better Impact (numeric)
    // account is among the losers, the merged person must carry the REAL BI id, not the wi- placeholder.
    // Promote the survivor to that id (retireInto rewrites it and re-buckets). Only for a single numeric
    // loser — 2+ BI accounts is the both-in-BI case the BI team resolves. Fold the promotion loser first
    // so the id is rewritten before any other folds run, then chain the rest onto the promoted survivor.
    let promoteTo = null;
    if (isWritein(survivorId)) {
      const numericLosers = loserIds.filter(id => !isWritein(id));
      if (numericLosers.length === 1) promoteTo = String(numericLosers[0]);
    }
    const newIdFor = (lid) => (promoteTo && String(lid) === promoteTo) ? promoteTo : undefined;
    const orderedLosers = promoteTo ? [promoteTo, ...loserIds.filter(id => String(id) !== promoteTo)] : loserIds;
    const results = [];
    if (!commit) {
      // DRY RUN: simulate sequentially against an in-memory copy so multi-loser folds are realistic.
      let workingSurvivor = { ...survivor };
      for (const lid of orderedLosers) {
        const loser = byId.get(lid);
        const m = mergeRecords(loser, workingSurvivor, { ...opts, winner: winnerFor(lid), newId: newIdFor(lid) });
        results.push({ loserId: lid, ok: m.ok, reason: m.reason || null,
          bothInBi: m.reason === "both_in_bi", needsWinner: m.reason === "both_accepted_needs_winner" });
        if (m.ok) workingSurvivor = m.record;   // chain: next loser folds into the growing survivor
      }
      // Same-id duplicates: fold the extra copies of the survivor's own id. Each is a distinct record
      // sharing the id; mergeRecords treats same-id as one account (no both_in_bi) and keeps the winner.
      const sameIdDupes = records.filter(r => String(r.user_id) === survivorId && r !== survivor).slice(0, sameIdToFold);
      for (const dup of sameIdDupes) {
        // Same account, so the surviving id is settled. Which record's WORK-BLOCK survives is decided
        // by progress (accepted > assigned > ...), not by which copy happened to sort first — pass no
        // winner and let mergeRecords take the higher-progress side. Only when BOTH copies are accepted
        // does it need an explicit pick (else it refuses a silent choice); keep the survivor's then.
        const bothAccepted = sameProgressAccepted(dup) && sameProgressAccepted(workingSurvivor);
        const m = mergeRecords(dup, workingSurvivor, { ...opts, winner: bothAccepted ? "survivor" : undefined });
        results.push({ loserId: survivorId + " (same-id copy)", ok: m.ok, reason: m.reason || null,
          bothInBi: false, needsWinner: m.reason === "both_accepted_needs_winner", sameId: true });
        if (m.ok) workingSurvivor = m.record;
      }
      context.res = { body: {
        mode: "dry-run", region, survivorId, loserIds, promotedTo: promoteTo, sameIdFolds: sameIdToFold,
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
    // (both_in_bi / needs winner), we record it and continue with the rest. The promotion fold (if any)
    // runs first and rewrites the survivor's id; subsequent folds chain onto the new id.
    let curSurvivor = survivorId;
    for (const lid of orderedLosers) {
      const r = await retireInto(container, region, lid, curSurvivor, { ...opts, winner: winnerFor(lid), newId: newIdFor(lid) });
      results.push({ loserId: lid, ...r, bothInBi: r.reason === "both_in_bi", needsWinner: r.reason === "both_accepted_needs_winner" });
      if (r.ok && r.survivorId) curSurvivor = String(r.survivorId);   // follow the promotion
    }
    // Fold the same-id duplicates. Each call collapses one extra copy of curSurvivor's id into it;
    // retireInto locates the pair by array position, so identical ids don't self-merge.
    for (let k = 0; k < sameIdToFold; k++) {
      // Decide the winner from progress at each step: read the two live copies of curSurvivor's id and
      // only force "survivor" if both are accepted; otherwise let retireInto/mergeRecords keep the
      // higher-progress record, so the accepted copy survives regardless of shard order.
      const live = (await readRegion(container, region)).records.filter(r => String(r.user_id) === curSurvivor);
      const bothAccepted = live.length >= 2 && live.slice(0, 2).every(sameProgressAccepted);
      const r = await retireInto(container, region, curSurvivor, curSurvivor, { ...opts, winner: bothAccepted ? "survivor" : undefined });
      results.push({ loserId: curSurvivor + " (same-id copy)", ...r, sameId: true,
        bothInBi: r.reason === "both_in_bi", needsWinner: r.reason === "both_accepted_needs_winner" });
      if (r.ok && r.survivorId) curSurvivor = String(r.survivorId);
    }
    context.res = { body: {
      mode: "commit", region, survivorId: curSurvivor, promotedTo: promoteTo, sameIdFolds: sameIdToFold,
      merged: results.filter(r => r.ok).length,
      refused: results.filter(r => !r.ok).length,
      results,
    } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
