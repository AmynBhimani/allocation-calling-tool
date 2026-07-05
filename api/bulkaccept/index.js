// Bulk-accept: mark a selected group as Accepted WITHOUT a call, for pre-formed teams who are already
// working together. Produces the exact same state a caller's "Accepted" outcome would (call_outcome,
// call_done, ivol_ready, an activity_log outcome entry) so they flow to the iVol report and count as
// accepted everywhere. Admin or Super Admin only; admins are region-walled to their events.
// Guards: skips leadership, already-accepted, unallocated (no final_area), in-reconciliation, and
// anyone outside the caller's regions — each reported so nothing happens silently.
const { getContainer, mutateVolunteer, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { callerLocked, LEADERSHIP } = require("../shared/status");
const { lastOutcome } = require("../shared/rollup");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

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
    if (!email || !(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return; }

    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) { context.res = { status: 400, body: { error: "No people selected." } }; return; }
    if (items.length > 1000) { context.res = { status: 400, body: { error: "Too many at once (max 1000). Narrow the selection." } }; return; }

    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = (region) => isSuper || (allowed && allowed.includes(region));

    const container = await getContainer(DATA_CONTAINER);
    const accepted = [], skipped = { leadership: 0, alreadyAccepted: 0, noArea: 0, inReconciliation: 0, outOfRegion: 0, notFound: 0, error: 0 };
    const now = new Date().toISOString();

    for (const it of items) {
      const user_id = it && it.user_id != null ? String(it.user_id) : "";
      const region = it && it.region ? String(it.region) : "";
      if (!user_id || !REGIONS.includes(region)) { skipped.error++; continue; }
      if (!inScope(region)) { skipped.outOfRegion++; continue; }

      const result = await mutateVolunteer(container, region, user_id, (v) => {
        if (v.callable_status === LEADERSHIP) return { skip: true, reason: "leadership" };
        const already = !!v.ivol_ready || v.call_outcome === "Accepted" || lastOutcome(v) === "Accepted";
        if (already) return { skip: true, reason: "alreadyAccepted" };
        if (!v.final_area) return { skip: true, reason: "noArea" };
        const claims = Array.isArray(v.conflict_claims) ? v.conflict_claims : [];
        if (v.callable_status === "In reconciliation" || claims.length >= 2) return { skip: true, reason: "inReconciliation" };

        // Mirror the caller's "Accepted" outcome exactly.
        v.activity_log = v.activity_log || [];
        v.activity_log.push({ ts: now, actor: email, action: "outcome", outcome: "Accepted", bulk: true, note: "Bulk-accepted by an admin (pre-formed team; no call needed)." });
        v.call_outcome = "Accepted";
        v.call_done = true;
        v.ivol_ready = true;
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
