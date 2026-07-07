// Restore one caller's lost assignments from a backup snapshot. Finds the volunteers that were
// assigned to the caller at that snapshot, and re-points ONLY the ones that are now unassigned back
// to them. Never overrides a volunteer that has since been called, accepted, or reassigned to another
// caller. Preview with ?dry=1 before committing. Super Admin only.
//
//   /api/restorecaller?list=1                                  -> available snapshot timestamps
//   /api/restorecaller?caller=<email>&snapshot=<ts>&dry=1      -> preview what would be restored
//   /api/restorecaller?caller=<email>&snapshot=<ts>            -> commit the restore
const { getContainer, readRegion, mutateVolunteer, REGIONS, readRolesStore, streamToString } = require("../shared/store");
const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const BACKUP_CONTAINER = process.env.BACKUP_CONTAINER || "backups";
const clean = (s) => String(s == null ? "" : s).trim();
const nm = (v) => ((v.first || "") + " " + (v.last || "")).trim();

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
async function listSnapshotStamps(svc) {
  const c = svc.getContainerClient(BACKUP_CONTAINER);
  const stamps = new Set();
  for await (const b of c.listBlobsFlat({ prefix: "snapshots/volunteers-" })) {
    const m = b.name.match(/-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ)\.json$/);
    if (m) stamps.add(m[1]);
  }
  return [...stamps].sort();
}
// Read a region's records from a snapshot — works for legacy (one file) and sharded (bucket files).
async function readSnapshotRegion(svc, region, stamp) {
  const c = svc.getContainerClient(BACKUP_CONTAINER);
  const all = [];
  for await (const b of c.listBlobsFlat({ prefix: `snapshots/volunteers-${region}` })) {
    if (!b.name.endsWith(`-${stamp}.json`)) continue;
    try { const recs = JSON.parse(await streamToString((await c.getBlockBlobClient(b.name).download()).readableStreamBody)); if (Array.isArray(recs)) for (const r of recs) all.push(r); } catch {}
  }
  return all;
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

    const buckets = { restore: [], alreadyAssigned: [], reassignedToOther: [], calledOrAccepted: [], notFound: [] };
    for (const s of snapAssigned) {
      const live = liveByRegion[s.region] && liveByRegion[s.region].get(String(s.user_id));
      if (!live) { buckets.notFound.push(s); continue; }
      const lc = clean(live.assigned_caller).toLowerCase();
      if (lc === caller) { buckets.alreadyAssigned.push(s); continue; }
      if (live.call_done || live.call_outcome === "Accepted" || live.ivol_ready) { buckets.calledOrAccepted.push(s); continue; }
      if (lc && lc !== caller) { buckets.reassignedToOther.push({ ...s, to: lc }); continue; }
      buckets.restore.push(s);   // now unassigned + not called -> safe to give back
    }

    let restored = 0;
    if (!dry) {
      for (const s of buckets.restore) {
        const res = await mutateVolunteer(container, s.region, s.user_id, (v) => {
          const lc = clean(v.assigned_caller).toLowerCase();
          if (lc === caller) return { skip: "already" };
          if (v.call_done || v.call_outcome === "Accepted" || v.ivol_ready) return { skip: "called" };
          if (lc && lc !== caller) return { skip: "reassigned" };
          v.assigned_caller = caller;
          v.activity_log = v.activity_log || [];
          v.activity_log.push({ ts: new Date().toISOString(), actor: "restore", action: "reassigned", note: `Restored to ${caller} from snapshot ${stamp}.` });
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
        notFound: buckets.notFound.length,
        detail: {
          restore: buckets.restore.slice(0, 500),
          reassignedToOther: buckets.reassignedToOther.slice(0, 200),
          calledOrAccepted: buckets.calledOrAccepted.slice(0, 200),
          notFound: buckets.notFound.slice(0, 200),
        },
        note: dry ? "Preview only — nothing changed. Re-run with &commit=1 (and remove dry) to apply the restore." : "Restore applied.",
      }
    };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
