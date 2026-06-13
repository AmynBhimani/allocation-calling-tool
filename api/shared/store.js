// Shared storage layer for volunteer data.
// Region shards (volunteers-<region>.json) with ETag optimistic concurrency so concurrent writes
// never silently overwrite each other — the real robustness fix for many simultaneous callers.

const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const REGIONS = ["BC", "Prairies", "Edmonton"];

function streamToString(s) {
  return new Promise((res, rej) => {
    const ch = []; s.on("data", d => ch.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(ch).toString("utf8"))); s.on("error", rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function isConditionError(e) {
  return e && (e.statusCode === 412 || e.code === "ConditionNotMet" ||
    e.code === "TargetConditionNotMet" || /condition/i.test(e.message || ""));
}

async function getContainer(name) {
  if (!CONN) throw new Error("RESPONSES_STORAGE not configured.");
  const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(name);
  await c.createIfNotExists();
  return c;
}

// Read one region shard. Returns { records, etag } (etag null if the blob doesn't exist yet).
async function readRegion(container, region) {
  const b = container.getBlockBlobClient(`volunteers-${region}.json`);
  if (!(await b.exists())) return { records: [], etag: null };
  const dl = await b.download();
  const text = await streamToString(dl.readableStreamBody);
  let records = [];
  try { records = JSON.parse(text); } catch { records = []; }
  return { records, etag: dl.etag };
}

// Write a region shard. If etag is given, the write only succeeds when the blob is unchanged
// (If-Match); if null, it only succeeds if the blob still doesn't exist (If-None-Match: *).
async function writeRegion(container, region, records, etag) {
  const b = container.getBlockBlobClient(`volunteers-${region}.json`);
  const body = JSON.stringify(records);
  const opts = { blobHTTPHeaders: { blobContentType: "application/json" } };
  opts.conditions = etag ? { ifMatch: etag } : { ifNoneMatch: "*" };
  await b.upload(body, Buffer.byteLength(body), opts);
}

// Overwrite a region shard unconditionally (used by seed / full reloads).
async function overwriteRegion(container, region, records) {
  const b = container.getBlockBlobClient(`volunteers-${region}.json`);
  const body = JSON.stringify(records);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" } });
}

// Safe single-volunteer update: read-modify-write with retry on ETag conflict.
// mutator(volunteer, allRecords) mutates the record in place; re-runs on each retry against fresh data.
async function mutateVolunteer(container, region, user_id, mutator, { retries = 8 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { records, etag } = await readRegion(container, region);
    const v = records.find(x => x.user_id === user_id);
    if (!v) return { ok: false, notFound: true };
    const extra = mutator(v, records);
    try {
      await writeRegion(container, region, records, etag);
      return { ok: true, volunteer: v, extra };
    } catch (e) {
      if (isConditionError(e) && attempt < retries) { await sleep(40 * (attempt + 1) + Math.random() * 50); continue; }
      throw e;
    }
  }
  return { ok: false, conflict: true };
}

// Safe bulk merge for a region (used by the sync): re-reads existing on conflict and re-applies
// mergeFn(existingRecords) -> newRecords, so concurrent caller writes are never clobbered by a sync.
async function mergeRegion(container, region, mergeFn, { retries = 6 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { records, etag } = await readRegion(container, region);
    const next = mergeFn(records);
    try {
      if (etag) await writeRegion(container, region, next, etag);
      else await writeRegion(container, region, next, null);
      return next;
    } catch (e) {
      if (isConditionError(e) && attempt < retries) { await sleep(50 * (attempt + 1) + Math.random() * 50); continue; }
      throw e;
    }
  }
  throw new Error(`mergeRegion: too many conflicts on ${region}`);
}

module.exports = {
  REGIONS, getContainer, readRegion, writeRegion, overwriteRegion, mutateVolunteer, mergeRegion, streamToString,
};
