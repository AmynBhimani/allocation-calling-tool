// Automated point-in-time backup: copies each region shard + the caller roster into a `backups`
// container, timestamped, keeping the most recent N. Called on a schedule by the hourly-backup
// GitHub Action (which has no Static Web App login), so it is gated by a shared secret
// (BACKUP_TRIGGER_KEY, header x-backup-key or ?key=). A logged-in Super Admin can also trigger it.
//
// App settings: BACKUP_TRIGGER_KEY (required). Optional: BACKUP_CONTAINER (default "backups"),
// BACKUP_KEEP (default 72 = ~3 days hourly), CONFIG_CONTAINER (default "app-config").
const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
const BACKUP_CONTAINER = process.env.BACKUP_CONTAINER || "backups";
const REGIONS = ["BC", "Prairies", "Edmonton"];
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 72));

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
function streamToBuffer(s) {
  return new Promise((res, rej) => { const ch = []; s.on("data", d => ch.push(Buffer.from(d))); s.on("end", () => res(Buffer.concat(ch))); s.on("error", rej); });
}
// Faithful byte copy of a blob into the backups container (no JSON parse — a raw snapshot).
async function snapshot(svc, srcContainer, srcName, dstName) {
  const src = svc.getContainerClient(srcContainer).getBlockBlobClient(srcName);
  if (!(await src.exists())) return false;
  const buf = await streamToBuffer((await src.download()).readableStreamBody);
  await svc.getContainerClient(BACKUP_CONTAINER).getBlockBlobClient(dstName).upload(buf, buf.length, { blobHTTPHeaders: { blobContentType: "application/json" } });
  return true;
}
// Keep only the newest KEEP snapshots per source (timestamp is in the name, so a name sort is chronological).
async function prune(svc) {
  const c = svc.getContainerClient(BACKUP_CONTAINER);
  const groups = {};
  for await (const b of c.listBlobsFlat({ prefix: "snapshots/" })) {
    const m = b.name.match(/^(snapshots\/.+)-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.json$/);   // group = name minus the timestamp
    const key = m ? m[1] : b.name;
    (groups[key] || (groups[key] = [])).push(b.name);
  }
  let deleted = 0;
  for (const key of Object.keys(groups)) {
    const names = groups[key].sort();
    for (const n of names.slice(0, Math.max(0, names.length - KEEP))) { await c.getBlockBlobClient(n).deleteIfExists(); deleted++; }
  }
  return deleted;
}

module.exports = async function (context, req) {
  try {
    const need = process.env.BACKUP_TRIGGER_KEY;
    if (!need) { context.res = { status: 500, body: { error: "BACKUP_TRIGGER_KEY is not configured." } }; return; }
    const got = req.headers["x-backup-key"] || (req.query && req.query.key) || "";
    const roles = (getPrincipal(req) || {}).userRoles || [];
    if (got !== need && !roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const svc = BlobServiceClient.fromConnectionString(CONN);
    await svc.getContainerClient(BACKUP_CONTAINER).createIfNotExists();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";

    // Snapshot EVERY volunteers-* blob that's actually live — this captures the single-blob layout
    // and the sharded layout (volunteers-<region>-<bucket>.json) alike, so it stays correct after a reshard.
    const dataC = svc.getContainerClient(DATA_CONTAINER);
    const volunteerBlobs = [];
    for await (const b of dataC.listBlobsFlat({ prefix: "volunteers-" })) if (/\.json$/i.test(b.name)) volunteerBlobs.push(b.name);
    const shards = [];
    for (const name of volunteerBlobs) {
      if (await snapshot(svc, DATA_CONTAINER, name, `snapshots/${name.replace(/\.json$/i, "")}-${stamp}.json`)) shards.push(name);
    }
    const rolesBackedUp = await snapshot(svc, CONFIG_CONTAINER, "roles.json", `snapshots/roles-${stamp}.json`);
    const pruned = await prune(svc);

    context.res = { body: { ok: true, stamp, container: BACKUP_CONTAINER, blobs: shards, rolesBackedUp, keepPerSource: KEEP, pruned } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
