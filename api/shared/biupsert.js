// Shared Better Impact upsert used by the BI snapshot refresh. Maps normalized BI records (from
// fields.normalize) to volunteer records, runs the allocation engine, and folds them into the per-region
// shards. Preservation model (matches the manual BI import, NOT the older API sync): reconciliation /
// calling / accept work is never lost, no-BI-account write-ins and any other touched app-only records are
// KEPT even when they aren't in the BI pull, and people who are in BI but not yet in the app are created
// Unassigned. Optionally leaves an un-pushed caller contact edit (bi_update_needed) intact so a refresh
// can't revert a correction before the iVol team sends it upstream.
const { allocate } = require("../sync/allocate");
const { WESTERN_JKS, REGIONS } = require("../sync/fields");
const { mergeRegion } = require("./store");
const { computeCallableStatus } = require("./status");
const { isTouched } = require("./preserve");

// (isTouched now lives in ./preserve so the file import, API sync, and BI refresh share one definition.)

// Build a volunteer record from a normalized BI record + its allocation. Same shape as the API sync.
function toRecord(r, a) {
  a = a || {};
  return {
    user_id: r.user_id, first: r.first, last: r.last, email: r.email, username: r.username,
    cell_phone: r.cell_phone, home_phone: r.home_phone, work_phone: r.work_phone,
    ceremony_jk: r.jk, region: a.region,
    birthday: r.birthday || null, age: (r.age != null ? r.age : null), interfaith: !!r.interfaith,
    list: a.list || null,
    pref_areas: r.areas ? Object.keys(r.areas).filter(k => r.areas[k]) : [],
    happy_anywhere: !!r.happy_anywhere,
    computed_area: a.computed_area, final_area: null,
    held_aside: !!a.held_aside,
    affinity_flag: false, leader_flag: false, conflict_claims: [],
    never_reviewed: true, new_since_sync: true,
    callable_status: "Unassigned",
    event_assignments: [],
    assigned_caller: null, ivol_entered: false, ivol_ready: false,
    no_bi_account: false, call_outcome: null, call_done: false, referred_from: null,
    activity_log: [],
  };
}

// The contact fields BI refreshes; each is protected on an existing record if it carries an un-pushed
// caller edit (bi_update_needed + a pending diff on that exact field). Mutates `out`; returns count kept.
const CONTACT_FIELDS = ["cell_phone", "home_phone", "work_phone", "email"];
function keepPendingEdits(old, out) {
  if (!old || !old.bi_update_needed || !old.contact_changes) return 0;
  let kept = 0;
  for (const f of CONTACT_FIELDS) if (old.contact_changes[f]) { out[f] = old[f]; kept++; }
  return kept;
}

// PURE per-region merge (no I/O — unit-tested). Folds fresh BI records into existing shard records.
function mergeFresh(fresh, existing, opts = {}) {
  const protectEdits = opts.protectEdits !== false;
  const exById = new Map(existing.map(v => [v.user_id, v]));
  let added = 0, preserved = 0, refreshed = 0, contactEditsKept = 0;
  const merged = fresh.map(nv => {
    const old = exById.get(nv.user_id);
    if (old && isTouched(old)) {
      // Preserve all work; refresh identity/contact/prefs from BI (age falls back to old if BI blank).
      preserved++;
      const out = { ...old,
        first: nv.first, last: nv.last, email: nv.email, username: nv.username,
        cell_phone: nv.cell_phone, home_phone: nv.home_phone, work_phone: nv.work_phone,
        ceremony_jk: nv.ceremony_jk, region: nv.region,
        birthday: nv.birthday || null, age: (nv.age != null ? nv.age : (old.age != null ? old.age : null)), interfaith: !!nv.interfaith,
        list: nv.list, computed_area: nv.computed_area, held_aside: nv.held_aside,
        pref_areas: nv.pref_areas, happy_anywhere: nv.happy_anywhere,
        new_since_sync: false };
      if (protectEdits) contactEditsKept += keepPendingEdits(old, out);
      return out;
    }
    if (old) {
      // Untouched existing: refresh from BI, keep any carried claims/flags, recompute status.
      refreshed++;
      const m = { ...nv, new_since_sync: false,
        affinity_flag: old.affinity_flag, leader_flag: old.leader_flag,
        conflict_claims: old.conflict_claims || [], event_assignments: old.event_assignments || [] };
      if (protectEdits) contactEditsKept += keepPendingEdits(old, m);
      m.callable_status = computeCallableStatus(m);
      return m;
    }
    added++;   // in BI, not yet in the app -> create Unassigned
    return nv;
  });
  // Keep touched app-only records that aren't in the BI pull (no-BI write-ins, etc.). Untouched
  // not-in-pull records are dropped (no work to lose; re-added if they return in a later pull).
  const freshIds = new Set(fresh.map(v => v.user_id));
  for (const old of existing) if (!freshIds.has(old.user_id) && isTouched(old)) merged.push(old);
  return { merged, added, preserved, refreshed, contactEditsKept };
}

// Upsert an array of NORMALIZED BI records into `container` (live commit). Returns a summary.
async function upsertNormalized(container, records, opts = {}) {
  const western = records.filter(r => r.jk && WESTERN_JKS.has(r.jk));
  const alloc = allocate(western);
  const allocById = new Map(alloc.map(a => [a.user_id, a]));
  const byRegion = { BC: [], Prairies: [], Edmonton: [] };
  for (const r of western) {
    const a = allocById.get(r.user_id) || {};
    const region = REGIONS.includes(a.region) ? a.region : null;
    if (!region) continue;
    byRegion[region].push(toRecord(r, a));
  }
  const summary = { western: western.length, added: 0, preserved: 0, refreshed: 0, contactEditsKept: 0, byRegion: {} };
  for (const region of REGIONS) {
    const fresh = byRegion[region];
    let m;
    const result = await mergeRegion(container, region, (existing) => {
      m = mergeFresh(fresh, existing, opts);
      return m.merged;
    });
    summary.added += m.added; summary.preserved += m.preserved; summary.refreshed += m.refreshed;
    summary.contactEditsKept += m.contactEditsKept; summary.byRegion[region] = result.length;
  }
  return summary;
}

module.exports = { upsertNormalized, mergeFresh, toRecord, keepPendingEdits, isTouched };
