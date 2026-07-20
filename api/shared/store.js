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
  // Read all shards concurrently so region-read latency stays flat as the shard count grows.
  // Promise.all preserves input order, so buckets 0..N-1 concatenate exactly as the old loop did.
  const parts = await Promise.all(Array.from({ length: SHARDS }, (_, b) => readBlob(container, shardName(region, b))));
  const all = [];
  for (const p of parts) for (const r of p.records) all.push(r);
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
async function mutateVolunteer(container, region, user_id, mutator, { retries = 12, prefer = null } = {}) {
  const name = SHARDS === 1 ? legacyName(region) : shardName(region, bucketOf(user_id, SHARDS));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { records, etag } = await readBlob(container, name);
    // Which record to mutate. Normally there is one per user_id, but a volunteer can be DUPLICATED
    // (an app copy plus a re-imported BI copy carry the same id, and BI sharding puts both in this same
    // blob). When the caller supplies `prefer`, act on the copy that satisfies it — for a caller action
    // that is the copy assigned to THEM, not whichever happens to sort first. Falls back to first match,
    // so every existing caller (no prefer) behaves exactly as before.
    const matches = records.filter(x => String(x.user_id) === String(user_id));   // compare by value: BI ids numeric, write-in ids strings
    const v = (prefer && matches.find(prefer)) || matches[0];
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

// ---- Record merge (de-duplication + write-in→BI promotion) ---------------------------------------
//
// retireInto(container, region, loserId, survivorId, opts) folds one duplicate volunteer record into
// another. Both the internal de-dup screen (two records for one human) and BI reconciliation (a
// write-in that has since gained a real BI account) reduce to this one primitive. The only structural
// difference is promotion, where the survivor's user_id is rewritten to a real BI id (opts.newId),
// which moves the record to a different shard bucket — mergeRegion handles that automatically because
// it re-splits the whole region on write.
//
// SAFETY MODEL:
//  - BI is the source of truth. If BOTH ids currently exist in Better Impact (opts.biIds), the two
//    accounts are genuinely distinct as far as BI is concerned, so we REFUSE to merge and defer to the
//    BI team to resolve upstream, then re-run. If exactly one is in BI, that record's identity fields
//    (contact / JK / age) are authoritative. If neither is in BI, we fall back to most-progress rules.
//  - No work is ever silently lost or downgraded: the higher-progress work-block (accepted > confirmed
//    > called > assigned > none) wins as the DEFAULT, but the caller may override which side wins via
//    opts.winner ("survivor" | "loser"). If BOTH are accepted, we refuse unless the caller has picked a
//    winner explicitly — a silent pick there is exactly the double-accept bug we are trying to kill.
//  - activity_log is the union of both, timestamp-sorted, plus a "merged" marker recording what folded
//    in and what was carried. merged_from accumulates TRANSITIVELY: the survivor inherits the loser's
//    own merged_from history plus the loser's id, so a chain A→B→C leaves C aware of A. transfer reads
//    merged_from to stay idempotent (it must never re-create a wi- record that was already merged away).

const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();
const dig10 = (s) => String(s == null ? "" : s).replace(/\D/g, "").slice(-10);

// The set of work fields that must move together as one coherent block.
const WORK_FIELDS = [
  "call_done", "call_outcome", "ivol_ready", "ivol_entered",
  "confirmed_at", "confirm_sent_at", "confirm_token",
  "declined_at", "decline_token", "accepted_notified_at", "no_response_status",
  "assigned_caller", "callable_status", "held_aside", "released_to_pool",
  "assigned_duty",
];
// Area/allocation fields that follow whichever work-block wins.
const AREA_FIELDS = ["final_area", "computed_area", "conflict_claims", "alloc_category", "affinity_flag",
  "referred_from", "referral_reason", "_prev_final"];

// Progress rank: higher = more advanced work that must not be discarded.
function progressRank(v) {
  const out = lc(v && v.call_outcome);
  if (v && (v.ivol_entered || v.confirmed_at)) return 5;      // confirmed / entered in iVol
  if (v && (v.ivol_ready || out === "accepted")) return 4;    // accepted
  if (v && v.call_done) return 3;                             // called and resolved
  if (out) return 2;                                          // some outcome recorded
  if (v && v.assigned_caller) return 1;                       // assigned to a caller, not yet called
  return 0;                                                   // untouched
}
const isAccepted = (v) => !!(v && (v.ivol_ready || lc(v.call_outcome) === "accepted"));

// Pure merge of two records. No I/O — this is the unit-tested core.
// Returns { ok, record?, reason? }. On ok, `record` is the survivor to keep; the loser is dropped.
function mergeRecords(loser, survivor, opts = {}) {
  const biIds = opts.biIds instanceof Set ? opts.biIds : new Set((opts.biIds || []).map(String));
  const loserInBi = biIds.has(String(loser.user_id));
  const survInBi = biIds.has(String(survivor.user_id));

  // Rule 1: two DIFFERENT live BI accounts -> normally refuse; Better Impact is the source of truth for
  // which account exists, and biupsert re-creates a record for any live BI account it can't find — so
  // folding two live accounts here would simply be undone by the next refresh.
  // But two records carrying the SAME BI id are not two accounts: they are ONE Better Impact account
  // duplicated inside the app (the app copy plus a re-imported BI copy). Merging them is exactly right,
  // and the surviving id is that same BI id — no refusal, nothing for the BI team to resolve.
  // The one exception for genuinely different accounts: the iVol admin, doing the merge in Better Impact,
  // may DECLARE which they are keeping (opts.biKeep). Naming it supplies the fact this rule is missing.
  // A generic "force" flag is still refused: biKeep must name the survivor.
  const sameBiId = String(loser.user_id) === String(survivor.user_id);
  if (loserInBi && survInBi && !sameBiId) {
    if (!opts.biKeep || String(opts.biKeep) !== String(survivor.user_id)) return { ok: false, reason: "both_in_bi" };
  }

  // Rule 2: both accepted -> the caller must have picked a winner; never silently choose.
  if (isAccepted(loser) && isAccepted(survivor) && !opts.winner) {
    return { ok: false, reason: "both_accepted_needs_winner" };
  }

  // Decide which side's WORK-BLOCK and AREA win.
  // Explicit winner overrides; else higher progress; ties keep the survivor's.
  let workWinner;
  if (opts.winner === "loser") workWinner = loser;
  else if (opts.winner === "survivor") workWinner = survivor;
  else workWinner = progressRank(loser) > progressRank(survivor) ? loser : survivor;
  const workLoser = workWinner === survivor ? loser : survivor;

  // Identity authority: if exactly one side is in BI, that side's contact/JK/age win.
  const biAuth = loserInBi ? loser : (survInBi ? survivor : null);

  const carried = [];   // for the merge marker
  const out = { ...survivor };   // survivor identity is the base

  // --- Promotion: rewrite the surviving user_id (moves shard bucket; mergeRegion handles it) ---
  if (opts.newId != null && String(opts.newId) !== String(out.user_id)) {
    carried.push(`user_id:${out.user_id}->${opts.newId}`);
    out.user_id = opts.newId;
    out.no_bi_account = false;   // it now has a real BI id
  }

  // --- Contact fields: BI-authoritative if applicable, else fill blanks from loser, never clobber ---
  for (const f of ["cell_phone", "home_phone", "work_phone", "email"]) {
    const sv = String(survivor[f] || "").trim();
    const lv = String(loser[f] || "").trim();
    if (biAuth) {
      const av = String(biAuth[f] || "").trim();
      if (av && av !== sv) { out[f] = biAuth[f]; carried.push(`${f}<=bi:${av}`); }
      else out[f] = survivor[f] || loser[f] || "";
    } else if (!sv && lv) {
      out[f] = loser[f]; carried.push(`${f}<=loser:${lv}`);   // fill blank only
    }
  }

  // --- ceremony_jk: BI-authoritative if applicable; else survivor keeps its own ---
  if (biAuth && String(biAuth.ceremony_jk || "").trim() &&
      lc(biAuth.ceremony_jk) !== lc(survivor.ceremony_jk)) {
    out.ceremony_jk = biAuth.ceremony_jk; carried.push(`ceremony_jk<=bi:${biAuth.ceremony_jk}`);
  }

  // --- age / birthday: BI-authoritative if applicable; else take a non-empty value ---
  for (const f of ["age", "birthday"]) {
    if (biAuth && biAuth[f] != null && biAuth[f] !== "" && biAuth[f] !== survivor[f]) {
      out[f] = biAuth[f]; carried.push(`${f}<=bi`);
    } else if ((survivor[f] == null || survivor[f] === "") && loser[f] != null && loser[f] !== "") {
      out[f] = loser[f];
    }
  }

  // --- Work-block + area: whichever side won moves as ONE coherent unit ---
  if (workWinner !== survivor) {
    for (const f of WORK_FIELDS) out[f] = workWinner[f];
    for (const f of AREA_FIELDS) out[f] = workWinner[f];
    carried.push("work_block<=loser");
  }
  // A merge must never UN-allocate someone: if the winning side has no final_area but the other side
  // does, inherit that area (and its allocation context) rather than leaving the survivor area-less.
  if (!String(out.final_area || "").trim()) {
    const other = workWinner === survivor ? loser : survivor;
    if (String(other.final_area || "").trim()) {
      for (const f of AREA_FIELDS) out[f] = other[f];
      carried.push(`final_area<=${other === loser ? "loser" : "survivor"}(was-empty)`);
    }
  }
  // conflict_claims: if the merge lands on a single final_area, clear the reconciliation flag.
  if (String(out.final_area || "").trim()) out.conflict_claims = [];

  // --- leader: OR of both ---
  const wasLeader = !!(survivor.leader_flag || survivor.leader || loser.leader_flag || loser.leader);
  out.leader_flag = wasLeader;
  if ("leader" in out || "leader" in loser) out.leader = wasLeader;

  // --- pref_areas / duty interests: union, so no captured interest is lost ---
  const unionArr = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  if (Array.isArray(survivor.pref_areas) || Array.isArray(loser.pref_areas)) {
    out.pref_areas = unionArr(survivor.pref_areas, loser.pref_areas);
  }
  out.happy_anywhere = !!(survivor.happy_anywhere || loser.happy_anywhere);

  // --- event_assignments: union by event; candidate_duties within a shared event are unioned ---
  const evBy = new Map();
  for (const e of [...(survivor.event_assignments || []), ...(loser.event_assignments || [])]) {
    if (!e || e.event == null) continue;
    const prev = evBy.get(e.event);
    if (!prev) { evBy.set(e.event, { ...e, candidate_duties: [...(e.candidate_duties || [])] }); }
    else prev.candidate_duties = unionArr(prev.candidate_duties, e.candidate_duties);
  }
  if (evBy.size) out.event_assignments = [...evBy.values()];

  // --- potential_duplicate: the dup is now resolved; clear the hint on the survivor ---
  delete out.potential_duplicate;

  // --- activity_log: union, timestamp-sorted, + a merge marker; merged_from accumulates transitively ---
  const priorMerged = new Set([
    ...(Array.isArray(survivor.merged_from) ? survivor.merged_from : []),
    ...(Array.isArray(loser.merged_from) ? loser.merged_from : []),
  ].map(String));
  priorMerged.add(String(loser.user_id));                    // the loser itself
  if (opts.newId != null) priorMerged.add(String(survivor.user_id));  // survivor's pre-promotion id
  // The surviving id is never "merged away" — exclude it. This matters when a promotion rewrites the id to
  // a folded loser's id: that id is now the survivor and must not linger in merged_from, where a later
  // sync would read it as gone and skip the (real, promoted) account.
  out.merged_from = [...priorMerged].filter(id => id !== String(out.user_id));

  const marker = {
    ts: new Date().toISOString(), actor: opts.actor || "retireInto", action: "merged",
    merged_from: String(loser.user_id),
    loser_state: { area: loser.final_area || null, outcome: loser.call_outcome || null,
      caller: loser.assigned_caller || null, accepted: isAccepted(loser) },
    winner: workWinner === survivor ? "survivor" : "loser",
    carried,
  };
  const log = [...(Array.isArray(survivor.activity_log) ? survivor.activity_log : []),
    ...(Array.isArray(loser.activity_log) ? loser.activity_log : []), marker];
  log.sort((a, b) => String(a && a.ts || "").localeCompare(String(b && b.ts || "")));
  out.activity_log = log;

  return { ok: true, record: out };
}

// I/O wrapper: applies mergeRecords inside a single region merge. Survivor is written to its correct
// (possibly new) bucket and the loser is removed, atomically per shard ETag. Because survivor and loser
// are usually in different buckets, mergeRegion writes the survivor's bucket before the loser's, so a
// mid-write failure leaves a harmless temporary duplicate rather than a lost record.
async function retireInto(container, region, loserId, survivorId, opts = {}) {
  let result = { ok: false, reason: "not_found" };
  await mergeRegion(container, region, (records) => {
    // Find by ARRAY POSITION, not by id value. A duplicate can carry the SAME BI id on both records
    // (the app copy plus a re-imported BI copy), and a find-by-id would return the same record twice
    // and merge it with itself, silently dropping the other. Positions keep the two distinct.
    let li = records.findIndex(r => String(r.user_id) === String(loserId));
    let si = records.findIndex(r => String(r.user_id) === String(survivorId));
    // Same id on both sides: the two findIndex calls land on the same row. Take the survivor as the
    // first match and the loser as the NEXT record sharing that id.
    if (li === si && li >= 0) {
      const dup = records.findIndex((r, k) => k !== si && String(r.user_id) === String(survivorId));
      if (dup < 0) { result = { ok: false, reason: "not_found" }; return records; }
      li = dup;
    }
    if (li < 0 || si < 0) { result = { ok: false, reason: "not_found" }; return records; }
    const loser = records[li], survivor = records[si];
    const m = mergeRecords(loser, survivor, opts);
    if (!m.ok) { result = m; return records; }               // refuse: write nothing
    result = { ok: true, survivorId: m.record.user_id, mergedFrom: m.record.merged_from };
    // Keep every record except those two POSITIONS, then append the merged survivor.
    const kept = records.filter((r, k) => k !== li && k !== si);
    kept.push(m.record);
    return kept;
  });
  return result;
}

module.exports = {
  REGIONS, getContainer, readRegion, writeRegion, overwriteRegion, mutateVolunteer, mergeRegion, streamToString,
  reshardRegion, bucketOf, SHARDS,
  readRolesStore, allowedRegionsFor, scopesFor, inScope, areasFor, readConfigJson, readDidars, readSessions,
  retireInto, mergeRecords, progressRank,   // mergeRecords + progressRank exported for unit tests
};

// ---- Role scoping -------------------------------------------------------------------------------
// roles.json is a flat list of {email, role, area, region} grants, so one person can hold the same
// role in several area x region cells. allowedRegionsFor() answers "which regions?"; these answer
// "which area x region cells?" — the finer question a quarterback's permissions turn on.
//
// Lived as an identical copy in api/assign and api/roleadmin until the duty review screen needed a
// third. Same rule in one place: whether someone may touch a lineup is not a thing to reimplement.
function scopesFor(store, email, role) {
  const e = String(email || "").toLowerCase().trim();
  return (store || [])
    .filter(a => String(a.email || "").toLowerCase().trim() === e && String(a.role || "").trim() === role)
    .map(a => ({ area: String(a.area || "").trim(), region: String(a.region || "").trim() }));
}

// An exact cell match, deliberately: a grant names one area in one region.
function inScope(scopes, area, region) {
  return (scopes || []).some(s => s.area === area && s.region === region);
}

// The distinct areas someone holds a role in, across every region. Used where a lineup spans regions
// (the July 24 Afternoon session covers Prairies AND Edmonton), so seeing the whole thing is decided
// by area while CHANGING part of it stays decided by area x region.
function areasFor(scopes) {
  return [...new Set((scopes || []).map(s => s.area).filter(Boolean))];
}

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
// Sessions (Mulaqats) under a Didar, with their Jamatkhana lists — the Session -> Ceremony JK mapping
// set on the Events screen. readDidars() deliberately excludes these (it filters to parent-less events
// and drops jamatkhanas), so the session allocation reads them here. Active sessions only.
async function readSessions(parentId) {
  const o = await readConfigJson("events.json");
  const arr = Array.isArray(o) ? o : ((o && o.events) || []);
  return arr.filter(e => e && e.parent && e.active !== false && (parentId == null || String(e.parent) === String(parentId)))
    .map(e => ({ id: e.id, name: e.name, parent: e.parent,
      jamatkhanas: Array.isArray(e.jamatkhanas) ? e.jamatkhanas : [], active: e.active !== false }));
}

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
