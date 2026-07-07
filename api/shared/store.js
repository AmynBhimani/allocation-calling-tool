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
// Throttling / transient storage errors that are worth retrying under heavy concurrent load.
function isTransientError(e) {
  if (!e) return false;
  const s = e.statusCode || e.status;
  if (s === 429 || s === 500 || s === 503 || s === 408) return true;
  const hay = String(e.code || "") + " " + String(e.message || "");
  return /throttl|ServerBusy|OperationTimedOut|InternalError|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(hay);
}
const isRetryable = (e) => isConditionError(e) || isTransientError(e);

async function getContainer(name) {
  if (!CONN) throw new Error("RESPONSES_STORAGE not configured.");
  const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(name);
  await c.createIfNotExists();
  return c;
}

// Read one region shard. Returns { records, etag } (etag null if the blob doesn't exist yet).
// ---- Region sharding ----------------------------------------------------------------------------
// A region is stored either as one legacy blob (volunteers-<region>.json) or split into
// SHARDS_PER_REGION smaller blobs (volunteers-<region>-<bucket>.json) keyed by a stable hash of
// user_id, which spreads write contention across many blobs. SHARDS defaults to 1 — byte-for-byte
// the original single-blob behavior — so deploying this changes NOTHING until SHARDS_PER_REGION is
// raised AND the data is migrated (api/reshard). Rollback is just setting it back to 1.
const SHARDS = Math.max(1, parseInt(process.env.SHARDS_PER_REGION, 10) || 1);
const legacyName = (region) => `volunteers-${region}.json`;
const shardName = (region, bucket) => `volunteers-${region}-${bucket}.json`;
function bucketOf(user_id, n) {
  const s = String(user_id); let h = 2166136261;                 // FNV-1a — deterministic across runs
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}
function splitBuckets(records, n) {
  const buckets = Array.from({ length: n }, () => []);
  for (const r of records) buckets[bucketOf(r.user_id, n)].push(r);
  return buckets;
}
// Read one blob into records with retry (never silently returns [] on a bad/partial read).
async function readBlob(container, name) {
  const b = container.getBlockBlobClient(name);
  if (!(await b.exists())) return { records: [], etag: null };
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const dl = await b.download();
      const text = await streamToString(dl.readableStreamBody);
      const records = JSON.parse(text);
      if (!Array.isArray(records)) throw new Error("shard did not parse to an array");
      return { records, etag: dl.etag };
    } catch (e) { lastErr = e; await sleep(70 * (attempt + 1) + Math.random() * 90); }
  }
  const err = new Error(`A data file (${name}) is busy right now — please try again in a moment.`);
  err.transientRead = true; throw err;
}
// Write one blob. etag -> If-Match (optimistic update); no etag + create -> If-None-Match:* (first
// write only); no etag + no create -> unconditional overwrite.
async function writeBlob(container, name, records, { etag = null, create = false } = {}) {
  const b = container.getBlockBlobClient(name);
  const body = JSON.stringify(records);
  const opts = { blobHTTPHeaders: { blobContentType: "application/json" } };
  if (etag) opts.conditions = { ifMatch: etag };
  else if (create) opts.conditions = { ifNoneMatch: "*" };
  await b.upload(body, Buffer.byteLength(body), opts);
}

async function readRegion(container, region) {
  if (SHARDS === 1) return readBlob(container, legacyName(region));
  const all = [];
  for (let b = 0; b < SHARDS; b++) { const { records } = await readBlob(container, shardName(region, b)); for (const r of records) all.push(r); }
  return { records: all, etag: null };
}

// Kept for backward-compat; operates on the legacy single blob.
async function writeRegion(container, region, records, etag) {
  await writeBlob(container, legacyName(region), records, { etag, create: !etag });
}

// Overwrite a region unconditionally (seed / full reload); splits across shards when SHARDS > 1.
async function overwriteRegion(container, region, records) {
  if (SHARDS === 1) { await writeBlob(container, legacyName(region), records, { create: false }); return; }
  const buckets = splitBuckets(records, SHARDS);
  for (let b = 0; b < SHARDS; b++) await writeBlob(container, shardName(region, b), buckets[b], { create: false });
}

// Safe single-volunteer update. Under sharding this reads+writes ONLY the one shard holding the
// volunteer (1/SHARDS of the data and of the contention), with ETag/transient retry. Note: the
// mutator's second argument is that shard's records, not the whole region — every current caller
// only uses the first argument (the volunteer), so this is safe.
async function mutateVolunteer(container, region, user_id, mutator, { retries = 12 } = {}) {
  const name = SHARDS === 1 ? legacyName(region) : shardName(region, bucketOf(user_id, SHARDS));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { records, etag } = await readBlob(container, name);
    const v = records.find(x => x.user_id === user_id);
    if (!v) return { ok: false, notFound: true };
    const extra = mutator(v, records);
    try {
      await writeBlob(container, name, records, { etag, create: !etag });
      return { ok: true, volunteer: v, extra };
    } catch (e) {
      if (isRetryable(e) && attempt < retries) { await sleep(50 * (attempt + 1) + Math.random() * 120); continue; }
      throw e;
    }
  }
  return { ok: false, conflict: true };
}

// Safe bulk merge for a region. mergeFn(allRecords) -> newRecords; re-reads on conflict so concurrent
// caller writes are never clobbered. Under sharding it reads every shard, merges the whole set, then
// re-splits and writes each shard with its own ETag.
async function mergeRegion(container, region, mergeFn, { retries = 6 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (SHARDS === 1) {
      const { records, etag } = await readBlob(container, legacyName(region));
      const next = mergeFn(records);
      try { await writeBlob(container, legacyName(region), next, { etag, create: !etag }); return next; }
      catch (e) { if (isRetryable(e) && attempt < retries) { await sleep(50 * (attempt + 1) + Math.random() * 50); continue; } throw e; }
    } else {
      const etags = [], all = [];
      for (let b = 0; b < SHARDS; b++) { const s = await readBlob(container, shardName(region, b)); etags.push(s.etag); for (const r of s.records) all.push(r); }
      const next = mergeFn(all);
      const buckets = splitBuckets(next, SHARDS);
      try {
        for (let b = 0; b < SHARDS; b++) await writeBlob(container, shardName(region, b), buckets[b], { etag: etags[b], create: !etags[b] });
        return next;
      } catch (e) { if (isRetryable(e) && attempt < retries) { await sleep(60 * (attempt + 1) + Math.random() * 80); continue; } throw e; }
    }
  }
  throw new Error(`mergeRegion: too many conflicts on ${region}`);
}

// Migration helper: rewrite a region into `toN` blobs, reading its CURRENT layout (env SHARDS). Never
// deletes the source layout, so flipping SHARDS_PER_REGION back is an instant, lossless rollback.
async function reshardRegion(container, region, toN) {
  const { records } = await readRegion(container, region);
  if (toN === 1) { await writeBlob(container, legacyName(region), records, { create: false }); return { region, total: records.length, to: 1 }; }
  const buckets = splitBuckets(records, toN);
  for (let b = 0; b < toN; b++) await writeBlob(container, shardName(region, b), buckets[b], { create: false });
  return { region, total: records.length, to: toN, perShard: buckets.map(x => x.length) };
}

module.exports = {
  REGIONS, getContainer, readRegion, writeRegion, overwriteRegion, mutateVolunteer, mergeRegion, streamToString,
  reshardRegion, bucketOf, SHARDS,
  readRolesStore, allowedRegionsFor, readConfigJson, readDidars,
};

// ---- Config readers (app-config/*.json) ----
async function readConfigJson(blobName) {
  if (!CONN) return null;
  try {
    const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
    const b = c.getBlockBlobClient(blobName);
    if (!(await b.exists())) return null;
    const dl = await b.download();
    return JSON.parse(await streamToString(dl.readableStreamBody));
  } catch { return null; }
}

// Active top-level Didars with their regions — { id, name, regions, active }.
async function readDidars() {
  const o = await readConfigJson("events.json");
  const arr = Array.isArray(o) ? o : ((o && o.events) || []);
  return arr.filter(e => e && !e.parent && e.active !== false)
    .map(e => ({ id: e.id, name: e.name, regions: Array.isArray(e.regions) ? e.regions : [], active: e.active !== false }));
}

// ---- Event/region wall ----
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";

// Read the role store (app-config/roles.json) — [{ email, role, region?, area?, event? }, ...].
async function readRolesStore() {
  if (!CONN) return [];
  try {
    const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
    const b = c.getBlockBlobClient("roles.json");
    if (!(await b.exists())) return [];
    const dl = await b.download();
    const text = await streamToString(dl.readableStreamBody);
    const obj = JSON.parse(text);
    return Array.isArray(obj) ? obj : (obj.assignments || []);
  } catch { return []; }
}

// The regions a person may see. Returns an array, or null meaning "all regions".
// null is returned for super-admins (callers pass that in) and for anyone with no region-scoped
// entries yet — so an untagged admin keeps global access until they're tagged to an event.
function allowedRegionsFor(store, email) {
  const e = String(email || "").toLowerCase().trim();
  const regions = [...new Set(
    store.filter(a => String(a.email || "").toLowerCase().trim() === e && String(a.region || "").trim())
      .map(a => String(a.region).trim())
  )];
  return regions.length ? regions : null;
}
