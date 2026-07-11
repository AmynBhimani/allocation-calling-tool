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
const { LEADERSHIP } = require("../shared/status");
const { lastOutcome } = require("../shared/rollup");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

// Which guard (if any) blocks a no-call accept. null => eligible. Order: most-definitive reason first.
function acceptGuard(v) {
  if (v.callable_status === LEADERSHIP) return "leadership";
  if (!!v.ivol_ready || v.call_outcome === "Accepted" || lastOutcome(v) === "Accepted") return "alreadyAccepted";
  if (!v.final_area) return "noArea";
  const claims = Array.isArray(v.conflict_claims) ? v.conflict_claims : [];
  if (v.callable_status === "In reconciliation" || claims.length >= 2) return "inReconciliation";
  if (v.assigned_caller) return "assignedToCaller";   // already on a caller's list — leave them to the caller
  return null;
}
const nm = (v) => ((v.first || "") + " " + (v.last || "")).trim() || ("#" + v.user_id);
const emptySkip = () => ({ leadership: 0, alreadyAccepted: 0, noArea: 0, inReconciliation: 0, assignedToCaller: 0, outOfRegion: 0, notFound: 0, error: 0 });

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
          for (const id of byRegion[region]) { const v = map.get(id); if (!v) { skipped.notFound++; continue; } consider(v, region); }
        }
      } else {
        for (const region of scopeRegions) {
          const { records } = await readRegion(container, region);
          for (const v of records) consider(v, region);
        }
      }
      wouldAccept.sort((a, b) => String(a.final_area || "").localeCompare(String(b.final_area || "")) || String(a.name).localeCompare(String(b.name)));
      context.res = { body: { mode: "dry-run", wouldAcceptCount: wouldAccept.length, wouldAccept: wouldAccept.slice(0, 3000), skipped } };
      return;
    }

    // ---- COMMIT: accept the provided items. ----
    if (!items.length) { context.res = { status: 400, body: { error: "No people selected." } }; return; }
    if (items.length > 2000) { context.res = { status: 400, body: { error: "Too many at once (max 2000). Narrow the selection." } }; return; }
    const accepted = [], skipped = emptySkip();
    const now = new Date().toISOString();
    for (const it of items) {
      const user_id = it && it.user_id != null ? String(it.user_id) : "";
      const region = it && it.region ? String(it.region) : "";
      if (!user_id || !REGIONS.includes(region)) { skipped.error++; continue; }
      if (!inScope(region)) { skipped.outOfRegion++; continue; }
      const result = await mutateVolunteer(container, region, user_id, (v) => {
        const g = acceptGuard(v);
        if (g) return { skip: true, reason: g };
        v.activity_log = v.activity_log || [];
        v.activity_log.push({ ts: now, actor: email, action: "outcome", outcome: "Accepted", bulk: true, note: "Bulk-accepted by an admin (pre-formed team; no call needed)." });
        v.call_outcome = "Accepted"; v.call_done = true; v.ivol_ready = true;
      });
      if (result.notFound) { skipped.notFound++; continue; }
      if (result.extra && result.extra.skip) { skipped[result.extra.reason] = (skipped[result.extra.reason] || 0) + 1; continue; }
      if (!result.ok) { skipped.error++; continue; }
      accepted.push({ user_id, region });
    }
    context.res = { body: { ok: true, acceptedCount: accepted.length, accepted: accepted.slice(0, 2000), skipped } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
