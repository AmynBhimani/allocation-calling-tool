// Restore one caller's lost assignments from a backup snapshot. Finds the volunteers that were
// assigned to the caller at that snapshot, and re-points ONLY the ones that are now unassigned back to
// them. Never touches a volunteer that has since been called, accepted, reassigned to another caller, or
// DELIBERATELY unassigned (released to pool / unassign / transfer). Preview with ?dry=1 first. Super Admin only.
//
//   /api/restorecaller?list=1                                  -> available snapshot timestamps
//   /api/restorecaller?caller=<email>&snapshot=<ts>&dry=1      -> preview what would be restored
//   /api/restorecaller?caller=<email>&snapshot=<ts>            -> commit the restore
//
// Undoing an ACCIDENTAL bulk unassign (which logs the same "unassign" as a deliberate one) needs an
// incident window, or every affected volunteer is skipped as deliberatelyRemoved:
//   ...&since=2026-07-08T15:14:23Z&until=2026-07-08T17:23:57Z&by=<actor-email>&dry=1
// Only the LAST clear event is judged, so anyone legitimately released after the incident stays put.
const { getContainer, readRegion, mutateVolunteer, REGIONS, readRolesStore } = require("../shared/store");
const { BlobServiceClient } = require("@azure/storage-blob");
const { listSnapshotStamps, readSnapshotRegion } = require("../shared/snapshots");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const BACKUP_CONTAINER = process.env.BACKUP_CONTAINER || "backups";
const clean = (s) => String(s == null ? "" : s).trim();
const nm = (v) => ((v.first || "") + " " + (v.last || "")).trim();

// A now-cleared assignment is DELIBERATE (not a silent loss) if the record was released to the pool, or
// its log shows an unassign / reassign / release / transfer event AFTER the last time it was assigned to
// THIS caller. We never restore those — the person was let go on purpose. A silent loss, by contrast,
// has the pointer cleared with no such event (the corruption signature), and only those get restored.
//
// INCIDENT OVERRIDE: an *accidental* bulk unassign logs the exact same "unassign" action as a deliberate
// one, so action alone can't tell them apart. When an incident window (&since=/&until=, optionally &by=)
// is supplied, a clear event that falls inside that window — and was written by that actor, if named —
// is treated as the accident we're undoing, so the volunteer becomes restorable. The override only
// applies to the LAST clear event: if someone was legitimately released *after* the incident, that later
// event still wins and they stay untouched. released_to_pool is a durable, deliberate state and is never
// overridden here.
const CLEAR_EVENTS = new Set(["unassign", "reassigned", "release_to_pool", "transfer_reconcile"]);
function matchesIncident(e, inc) {
  if (!inc || !e) return false;
  if (inc.by && clean(e.actor).toLowerCase() !== inc.by) return false;
  const t = Date.parse(e.ts || "");
  if (!Number.isFinite(t)) return false;
  if (inc.since != null && t < inc.since) return false;
  if (inc.until != null && t > inc.until) return false;
  return true;
}
function deliberatelyRemoved(v, caller, inc) {
  if (v && v.released_to_pool) return true;
  const log = Array.isArray(v && v.activity_log) ? v.activity_log : [];
  let lastAssign = -1;
  for (let i = 0; i < log.length; i++) { const e = log[i] || {}; if (e.action === "assign" && clean(e.to).toLowerCase() === caller) lastAssign = i; }
  const after = (lastAssign >= 0 ? log.slice(lastAssign + 1) : log).filter(e => e && CLEAR_EVENTS.has(e.action));
  if (!after.length) return false;                                  // no clear event -> silent loss
  return !matchesIncident(after[after.length - 1], inc);            // last clear event decides
}

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const roles = (getPrincipal(req) || {}).userRoles || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }
    const svc = BlobServiceClient.fromConnectionString(CONN);

    if (req.query && (req.query.list === "1" || req.query.list === "true")) {
      context.res = { body: { snapshots: await listSnapshotStamps(svc) } }; return;
    }

    const caller = clean(req.query && req.query.caller).toLowerCase();
    const stamp = clean(req.query && req.query.snapshot);
    if (!caller || !stamp) { context.res = { status: 400, body: { error: "Pass ?caller=<email>&snapshot=<timestamp>. Use ?list=1 to see snapshots, and add &dry=1 to preview." } }; return; }
    const dry = !(req.query && (req.query.dry === "0")) && (req.query && (req.query.dry === "1" || req.query.dry === "true") || !(req.query && req.query.commit === "1"));
    // ^ default to DRY unless commit=1 is passed; explicit dry=1 also honored.

    // Optional incident window: treat clear events inside it (by this actor, if named) as the accident
    // being undone rather than a deliberate removal. Inactive unless &since= is supplied.
    const q = req.query || {};
    let inc = null;
    if (clean(q.since)) {
      const since = Date.parse(clean(q.since));
      const until = clean(q.until) ? Date.parse(clean(q.until)) : null;
      if (!Number.isFinite(since) || (clean(q.until) && !Number.isFinite(until))) {
        context.res = { status: 400, body: { error: "since/until must be ISO timestamps, e.g. since=2026-07-08T15:14:23Z" } }; return;
      }
      inc = { since, until: Number.isFinite(until) ? until : null, by: clean(q.by).toLowerCase() || null };
    }

    // Regions the caller works (from the roster); fall back to all if unknown.
    const store = await readRolesStore();
    let regions = [...new Set(store.filter(a => clean(a.email).toLowerCase() === caller && clean(a.role) === "caller").map(a => clean(a.region)).filter(Boolean))];
    if (!regions.length) regions = REGIONS.slice();

    // Who was assigned to the caller at the snapshot.
    const snapAssigned = [];   // { user_id, region, name }
    for (const region of regions) {
      for (const v of await readSnapshotRegion(svc, region, stamp)) {
        if (clean(v.assigned_caller).toLowerCase() === caller) snapAssigned.push({ user_id: v.user_id, region, name: nm(v) });
      }
    }

    // Compare against live (read each region once).
    const container = await getContainer(DATA_CONTAINER);
    const liveByRegion = {};
    for (const region of regions) { const { records } = await readRegion(container, region); const m = new Map(); for (const v of records) m.set(String(v.user_id), v); liveByRegion[region] = m; }

    const buckets = { restore: [], alreadyAssigned: [], reassignedToOther: [], calledOrAccepted: [], deliberatelyRemoved: [], notFound: [] };
    for (const s of snapAssigned) {
      const live = liveByRegion[s.region] && liveByRegion[s.region].get(String(s.user_id));
      if (!live) { buckets.notFound.push(s); continue; }
      const lc = clean(live.assigned_caller).toLowerCase();
      if (lc === caller) { buckets.alreadyAssigned.push(s); continue; }
      if (live.call_done || live.call_outcome === "Accepted" || live.ivol_ready) { buckets.calledOrAccepted.push(s); continue; }
      if (lc && lc !== caller) { buckets.reassignedToOther.push({ ...s, to: lc }); continue; }
      if (deliberatelyRemoved(live, caller, inc)) { buckets.deliberatelyRemoved.push(s); continue; }  // unassigned ON PURPOSE
      const cleared = (Array.isArray(live.activity_log) ? live.activity_log : []).filter(e => e && CLEAR_EVENTS.has(e.action));
      buckets.restore.push({ ...s, why: cleared.length ? "incident" : "silent" });
    }

    let restored = 0;
    if (!dry) {
      for (const s of buckets.restore) {
        const res = await mutateVolunteer(container, s.region, s.user_id, (v) => {
          const lc = clean(v.assigned_caller).toLowerCase();
          if (lc === caller) return { skip: "already" };
          if (v.call_done || v.call_outcome === "Accepted" || v.ivol_ready) return { skip: "called" };
          if (lc && lc !== caller) return { skip: "reassigned" };
          if (deliberatelyRemoved(v, caller, inc)) return { skip: "deliberate" };
          v.assigned_caller = caller;
          v.activity_log = v.activity_log || [];
          // Logged as "assign" (not "reassigned") on purpose: "reassigned" is a CLEAR_EVENT, so using it
          // here would make a future restore read this very entry as a deliberate removal.
          v.activity_log.push({ ts: new Date().toISOString(), actor: "restore", action: "assign", to: caller, note: `Restored to ${caller} from snapshot ${stamp}.` });
        });
        if (res.ok && !(res.extra && res.extra.skip)) restored++;
      }
    }

    context.res = {
      body: {
        caller, snapshot: stamp, dryRun: dry, regions,
        assignedInSnapshot: snapAssigned.length,
        wouldRestore: buckets.restore.length, restored: dry ? 0 : restored,
        alreadyAssigned: buckets.alreadyAssigned.length,
        reassignedToOther: buckets.reassignedToOther.length,
        calledOrAccepted: buckets.calledOrAccepted.length,
        deliberatelyRemoved: buckets.deliberatelyRemoved.length,
        incident: inc ? { since: new Date(inc.since).toISOString(), until: inc.until ? new Date(inc.until).toISOString() : null, by: inc.by || "(any actor)" } : null,
        notFound: buckets.notFound.length,
        detail: {
          restore: buckets.restore.slice(0, 500),
          reassignedToOther: buckets.reassignedToOther.slice(0, 200),
          calledOrAccepted: buckets.calledOrAccepted.slice(0, 200),
          deliberatelyRemoved: buckets.deliberatelyRemoved.slice(0, 200),
          notFound: buckets.notFound.slice(0, 200),
        },
        note: dry ? "Preview only — nothing changed. Re-run with &commit=1 (and remove dry) to apply the restore." : "Restore applied.",
      }
    };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
