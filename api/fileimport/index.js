const { allocate } = require("../sync/allocate");
const { WESTERN_JKS, REGIONS } = require("../sync/fields");
const { getContainer, overwriteRegion, mergeRegion } = require("../shared/store");
const { computeCallableStatus } = require("../shared/status");

const CONN = process.env.RESPONSES_STORAGE;

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
// Same preservation rule as the API sync: never lose call/reconciliation state or no-BI-account people.
function isTouched(v) {
  return (Array.isArray(v.activity_log) && v.activity_log.length > 0) || !!v.assigned_caller || !!v.ivol_entered
    || v.callable_status === "Leadership - Do Not Allocate" || !!v.no_bi_account || !!v.released_to_pool;
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const body = req.body || {};
    const mode = (body.mode || "dry").toLowerCase();              // 'dry' or 'commit'
    const incoming = Array.isArray(body.records) ? body.records : [];
    if (!incoming.length) { context.res = { status: 400, body: { error: "No records received." } }; return; }

    // Re-filter to the 27 Western JKs server-side (defensive — client already filters).
    const western = incoming.filter(r => r.jk && WESTERN_JKS.has(r.jk));

    // Same engine the API sync uses.
    const alloc = allocate(western);
    const allocById = new Map(alloc.map(a => [a.user_id, a]));

    const byRegion = { BC: [], Prairies: [], Edmonton: [] };
    for (const r of western) {
      const a = allocById.get(r.user_id) || {};
      const region = REGIONS.includes(a.region) ? a.region : null;
      if (!region) continue;
      byRegion[region].push({
        user_id: r.user_id, first: r.first, last: r.last, email: r.email, username: r.username,
        cell_phone: r.cell_phone, home_phone: r.home_phone, work_phone: r.work_phone,
        ceremony_jk: r.jk, region,
        age: (r.age != null && r.age !== "" ? Number(r.age) : null), interfaith: !!r.interfaith,
        list: a.list || null,
        // Full Better Impact preference set + the "happy anywhere" flag, retained for the
        // multi-pick bulk allocation (computed_area above is just the single top-priority pick).
        pref_areas: r.areas ? Object.keys(r.areas).filter(function (k) { return r.areas[k]; }) : [],
        happy_anywhere: !!r.happy_anywhere,
        // computed_area is the engine's suggestion; final_area stays empty until a reconcile
        // decision confirms it. That is what keeps never-reviewed people out of the callable pool.
        computed_area: a.computed_area, final_area: null,
        held_aside: !!a.held_aside,
        affinity_flag: false, leader_flag: false, conflict_claims: [],
        never_reviewed: true, new_since_sync: true,
        callable_status: "Unassigned",
        event_assignments: [],
        assigned_caller: null, ivol_entered: false, ivol_ready: false,
        no_bi_account: false, call_outcome: null, call_done: false, referred_from: null,
        activity_log: []
      });
    }

    const targetContainer = mode === "commit" ? "tool-data" : "tool-data-dryrun";
    const container = await getContainer(targetContainer);
    const summary = { mode, target: targetContainer, received: incoming.length, western: western.length,
      added: 0, preserved: 0, refreshed: 0, byRegion: {}, byArea: {}, byStatus: {} };

    function mergeFn(fresh) {
      return (existing) => {
        const exById = new Map(existing.map(v => [v.user_id, v]));
        const merged = fresh.map(nv => {
          const old = exById.get(nv.user_id);
          if (old && isTouched(old)) {
            summary.preserved++;
            return { ...old,
              first: nv.first, last: nv.last, email: nv.email, username: nv.username,
              cell_phone: nv.cell_phone, home_phone: nv.home_phone, work_phone: nv.work_phone,
              ceremony_jk: nv.ceremony_jk, region: nv.region,
              age: nv.age != null ? nv.age : (old.age != null ? old.age : null), interfaith: !!nv.interfaith,
              list: nv.list, computed_area: nv.computed_area, held_aside: nv.held_aside,
              pref_areas: nv.pref_areas, happy_anywhere: nv.happy_anywhere,
              new_since_sync: false };
          }
          if (old) {
            summary.refreshed++;
            const m = { ...nv, new_since_sync: false,
              affinity_flag: old.affinity_flag, leader_flag: old.leader_flag,
              conflict_claims: old.conflict_claims || [],
              event_assignments: old.event_assignments || [] };
            m.callable_status = computeCallableStatus(m);   // respect any carried-over claims
            return m;
          }
          summary.added++;
          return nv;
        });
        // keep any existing touched records not present in the import (e.g. injected no_bi_account people)
        const freshIds = new Set(fresh.map(v => v.user_id));
        for (const old of existing) if (!freshIds.has(old.user_id) && isTouched(old)) merged.push(old);
        return merged;
      };
    }

    for (const region of REGIONS) {
      const fresh = byRegion[region];
      let result;
      if (mode === "commit") result = await mergeRegion(container, region, mergeFn(fresh));
      else { result = fresh; summary.added += fresh.length; await overwriteRegion(container, region, fresh); }
      summary.byRegion[region] = result.length;
      for (const v of result) {
        if (v.computed_area) summary.byArea[v.computed_area] = (summary.byArea[v.computed_area] || 0) + 1;
        summary.byStatus[v.callable_status] = (summary.byStatus[v.callable_status] || 0) + 1;
      }
    }

    summary.note = mode === "dry"
      ? "DRY RUN — wrote to tool-data-dryrun. Review the counts, then run Commit."
      : "COMMIT — wrote to tool-data with call-state preservation.";
    context.res = { body: summary };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
