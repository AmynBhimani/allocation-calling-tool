// Bulk-accept: mark people as Accepted WITHOUT a call, for pre-formed teams already working together.
// Produces the exact state a caller's "Accepted" outcome would (call_outcome, call_done, ivol_ready, an
// activity_log entry) so they flow to the iVol report and count as accepted everywhere. Admin or Super
// Admin only; admins are region-walled. Two modes:
//   - dryRun (body.dryRun:true or ?dry=1): partition candidates WITHOUT writing. With no items, it
//     evaluates everyone in scope (used by the migration mass-accept to list who's eligible).
//   - commit (default, with items): accept the provided people.
// Guards (skip, each reported so nothing is silent): leadership, already-accepted, no final area,
// in-reconciliation, ON A CALLER'S LIST (assigned_caller set — left to that caller), and out-of-region.
const { getContainer, readRegion, mutateVolunteer, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { acceptGuard } = require("../shared/accept");
const { lastOutcome } = require("../shared/rollup");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
// (acceptGuard now lives in ../shared/accept — shared with the team-file accept.)
const nm = (v) => ((v.first || "") + " " + (v.last || "")).trim() || ("#" + v.user_id);
const emptySkip = () => ({ leadership: 0, alreadyAccepted: 0, noArea: 0, inReconciliation: 0, assignedToCaller: 0, notFromReview: 0, outOfRegion: 0, notFound: 0, error: 0 });

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
    if (!email || !(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return; }

    const body = req.body || {};
    const dryRun = body.dryRun === true || req.query.dry === "1";
    const items = Array.isArray(body.items) ? body.items : [];
    // Scope the migration mass-accept to ONLY people the review migration brought in: never_reviewed===false
    // is the codebase's marker for "given an area by the review transfer" (release.js / alloc.js key on it).
    // This excludes anyone who got an area another way — e.g. allocated by the allocation tool but not yet
    // called — so they are never auto-accepted without a call. The All Volunteers bulk-accept omits this flag.
    const fromReviewOnly = body.fromReviewOnly === true;
    const inMigration = (v) => !fromReviewOnly || v.never_reviewed === false;

    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = (region) => isSuper || (allowed && allowed.includes(region));
    const scopeRegions = REGIONS.filter(inScope);
    const container = await getContainer(DATA_CONTAINER);

    // ---- DRY RUN: partition without writing. No items => evaluate everyone in scope. ----
    if (dryRun) {
      const wouldAccept = [], skipped = emptySkip();
      const consider = (v, region) => {
        const g = acceptGuard(v);
        if (g) skipped[g] = (skipped[g] || 0) + 1;
        else wouldAccept.push({ user_id: v.user_id, region, name: nm(v), final_area: v.final_area, ceremony_jk: v.ceremony_jk || "" });
      };
      if (items.length) {
        const byRegion = {};
        for (const it of items) { const r = it && it.region; if (r) (byRegion[r] = byRegion[r] || []).push(String(it.user_id)); }
        for (const region of Object.keys(byRegion)) {
          if (!inScope(region)) { skipped.outOfRegion += byRegion[region].length; continue; }
          const { records } = await readRegion(container, region);
          const map = new Map(records.map(v => [String(v.user_id), v]));
          for (const id of byRegion[region]) { const v = map.get(id); if (!v) { skipped.notFound++; continue; } if (!inMigration(v)) { skipped.notFromReview++; continue; } consider(v, region); }
        }
      } else {
        for (const region of scopeRegions) {
          const { records } = await readRegion(container, region);
          for (const v of records) { if (!inMigration(v)) continue; consider(v, region); }
        }
      }
      wouldAccept.sort((a, b) => String(a.final_area || "").localeCompare(String(b.final_area || "")) || String(a.name).localeCompare(String(b.name)));
      context.res = { body: { mode: "dry-run", wouldAcceptCount: wouldAccept.length, wouldAccept: wouldAccept.slice(0, 3000), skipped } };
      return;
    }

    // ---- COMMIT: accept the provided items. ----
    if (!items.length) { context.res = { status: 400, body: { error: "No people selected." } }; return; }
    if (items.length > 2000) { context.res = { status: 400, body: { error: "Too many at once (max 2000). Narrow the selection." } }; return; }
    const accepted = [], skipped = emptySkip(), skippedItems = [];
    const now = new Date().toISOString();
    for (const it of items) {
      const user_id = it && it.user_id != null ? String(it.user_id) : "";
      const region = it && it.region ? String(it.region) : "";
      if (!user_id || !REGIONS.includes(region)) { skipped.error++; skippedItems.push({ user_id, region, reason: "error" }); continue; }
      if (!inScope(region)) { skipped.outOfRegion++; skippedItems.push({ user_id, region, reason: "outOfRegion" }); continue; }
      const result = await mutateVolunteer(container, region, user_id, (v) => {
        if (!inMigration(v)) return { skip: true, reason: "notFromReview" };
        const g = acceptGuard(v);
        if (g) return { skip: true, reason: g };
        v.activity_log = v.activity_log || [];
        v.activity_log.push({ ts: now, actor: email, action: "outcome", outcome: "Accepted", bulk: true, note: "Bulk-accepted by an admin (pre-formed team; no call needed)." });
        v.call_outcome = "Accepted"; v.call_done = true; v.ivol_ready = true;
      });
      if (result.notFound) { skipped.notFound++; skippedItems.push({ user_id, region, reason: "notFound" }); continue; }
      if (result.extra && result.extra.skip) { skipped[result.extra.reason] = (skipped[result.extra.reason] || 0) + 1; skippedItems.push({ user_id, region, reason: result.extra.reason }); continue; }
      if (!result.ok) { skipped.error++; skippedItems.push({ user_id, region, reason: "error" }); continue; }
      accepted.push({ user_id, region });
    }
    context.res = { body: { ok: true, acceptedCount: accepted.length, accepted: accepted.slice(0, 2000), skipped, skippedItems: skippedItems.slice(0, 2000) } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
