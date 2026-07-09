// Shared, read-only helpers for reading backup snapshots. Single source of truth: the dual-layer
// handling below is subtle and must not be copy-pasted into individual endpoints.
const { streamToString } = require("./store");

const BACKUP_CONTAINER = process.env.BACKUP_CONTAINER || "backups";

// Snapshot stamps look like 2026-07-08T15-14-23Z (colons swapped for dashes so they're legal blob names).
const STAMP_RE = /-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ)\.json$/;

// "2026-07-08T15-14-23Z" -> Date. Only the TIME dashes become colons; the date's stay put.
function stampToDate(stamp) {
  const s = String(stamp);
  const iso = s.slice(0, 10) + "T" + s.slice(11, 19).replace(/-/g, ":") + "Z";
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

async function listSnapshotStamps(svc) {
  const c = svc.getContainerClient(BACKUP_CONTAINER);
  const stamps = new Set();
  for await (const b of c.listBlobsFlat({ prefix: "snapshots/volunteers-" })) {
    const m = b.name.match(STAMP_RE);
    if (m) stamps.add(m[1]);
  }
  return [...stamps].sort();
}

// The n most recent stamps at or before `beforeMs`, newest first. Used to look back across several
// backups and see when a caller's list changed.
function pickStampsBefore(stamps, beforeMs, n) {
  return stamps
    .map(s => ({ s, d: stampToDate(s) }))
    .filter(x => x.d && x.d.getTime() <= beforeMs)
    .sort((a, b) => b.d - a.d)
    .slice(0, Math.max(1, n))
    .map(x => x.s);
}

// Read a region's records from a snapshot. A single snapshot can hold BOTH layouts at the same stamp
// when a reshard left the pre-reshard whole-region file (`volunteers-<region>.json`) in place next to
// the new bucket files (`volunteers-<region>-<n>.json`) — the backup copies whatever is live, so it
// grabs both. Reading both returns every person twice (the 2x that made a caller's list look doubled).
// So: prefer the sharded bucket files when any exist for this stamp, fall back to the single legacy
// file only when there are none, and dedupe by user_id as a final guard.
async function readSnapshotRegion(svc, region, stamp) {
  const c = svc.getContainerClient(BACKUP_CONTAINER);
  const rx = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bucketRe = new RegExp(`^snapshots/volunteers-${rx(region)}-\\d+-${rx(stamp)}\\.json$`);
  const legacyRe = new RegExp(`^snapshots/volunteers-${rx(region)}-${rx(stamp)}\\.json$`);
  const bucketBlobs = [], legacyBlobs = [];
  for await (const b of c.listBlobsFlat({ prefix: `snapshots/volunteers-${region}-` })) {
    if (bucketRe.test(b.name)) bucketBlobs.push(b.name);
    else if (legacyRe.test(b.name)) legacyBlobs.push(b.name);
  }
  const chosen = bucketBlobs.length ? bucketBlobs : legacyBlobs;   // never blend the two layouts
  const parts = await Promise.all(chosen.map(async (name) => {     // shards read concurrently
    try {
      const recs = JSON.parse(await streamToString((await c.getBlockBlobClient(name).download()).readableStreamBody));
      return Array.isArray(recs) ? recs : [];
    } catch { return []; }
  }));
  const byId = new Map();
  for (const recs of parts) for (const r of recs) byId.set(String(r.user_id), r);
  return [...byId.values()];
}

module.exports = { BACKUP_CONTAINER, listSnapshotStamps, readSnapshotRegion, stampToDate, pickStampsBefore };
