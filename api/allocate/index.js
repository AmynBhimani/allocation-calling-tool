const { getContainer, readRegion, mergeRegion, REGIONS, readDidars } = require("../shared/store");
const { computeCallableStatus, seedEventAssignments, callerLocked } = require("../shared/status");
const { allocate } = require("./alloc");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const AS_OF = "2026-07-23";
const DEFAULT_SEED = 20260723;

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = (principal && principal.userDetails) || "";
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }

    const body = req.body || {};
    const commit = req.method === "POST" && body.mode === "commit";
    const seed = Number.isFinite(body.seed) ? body.seed : DEFAULT_SEED;
    const targets = Array.isArray(body.targets) ? body.targets : null;
    const rounds = Number.isFinite(body.rounds) ? body.rounds : 4;
    const overflow = body.overflow !== false;   // default ON: no Unassigned, allow overage
    const happyFirst = body.happyFirst === true;            // default OFF: pickers first
    const flexOrder = (body.flexOrder === "scarce") ? "scarce" : "below";  // default: furthest-below-target
    // Incremental: keep everyone who already has an area (review, a prior allocation, or a caller list)
    // and only distribute the currently-unassigned pool. Full (default): re-allocate the whole pool.
    const incremental = body.allocMode === "incremental" || body.keepPlaced === true;
    // For allocation, "locked" means do-not-touch: real call activity OR simply being on a caller's list.
    const allocLocked = (v) => callerLocked(v) || !!v.assigned_caller;

    // Scope to a single event: a Didar owns a region set, so "allocate this event" = allocate its regions.
    // No event given -> all regions (backward compatible).
    const allDidars = await readDidars();
    const eventId = (body.event && String(body.event)) || "";
    const didar = eventId ? allDidars.find(d => String(d.id) === eventId) : null;
    if (eventId && !didar) { context.res = { status: 400, body: { error: "Unknown event." } }; return; }
    const scopeRegions = didar ? REGIONS.filter(r => (didar.regions || []).indexOf(r) >= 0) : REGIONS;
    if (!scopeRegions.length) { context.res = { status: 400, body: { error: "That event has no regions configured yet." } }; return; }

    // Read all shards and assemble the engine's input records — counting each person ONCE.
    // A user_id can wrongly appear in two shards if their region changed between imports
    // (the old shard keeps a touched copy). We dedupe by user_id and report the conflicts.
    const container = await getContainer(DATA_CONTAINER);
    const recordsByRegion = {};
    const records = [];
    const seenRegion = new Map();     // user_id -> first region it was counted in
    const dupMap = new Map();         // user_id -> [regions...]
    let rawRecords = 0, writeIns = 0, lockedInPipeline = 0;
    for (const region of scopeRegions) {
      const { records: rs } = await readRegion(container, region);
      recordsByRegion[region] = rs;
      for (const v of rs) {
        rawRecords++;
        if (v.no_bi_account || v.source === "writein") writeIns++;
        const id = String(v.user_id);
        if (seenRegion.has(id)) {                         // already counted — this is a duplicate row
          if (!dupMap.has(id)) dupMap.set(id, [seenRegion.get(id)]);
          dupMap.get(id).push(region);
          continue;
        }
        seenRegion.set(id, region);
        const locked = allocLocked(v);          // call activity OR on a caller's list -> never re-allocate
        if (locked) lockedInPipeline++;
        // Fixed = pinned to their current area and counted toward it (never re-allocated). Always true for
        // locked people; in incremental mode, also true for anyone who already holds an area.
        const fixed = locked || (incremental && !!v.final_area);
        records.push({
          user_id: v.user_id, region, email: v.email || null,
          computed_area: v.computed_area || null, final_area: v.final_area || null,
          // A fixed person is treated as "reviewed" so the engine keeps them put (affinity) and counts
          // them toward their area's target, both in preview and at commit.
          never_reviewed: fixed ? false : !!v.never_reviewed, leader_flag: !!v.leader_flag,
          conflict_claims: Array.isArray(v.conflict_claims) ? v.conflict_claims : [],
          list: v.list || null, interfaith: !!v.interfaith,
          age: (v.age != null ? v.age : null), birthday: v.birthday || null,
          pref_areas: Array.isArray(v.pref_areas) ? v.pref_areas : [], happy_anywhere: !!v.happy_anywhere,
        });
      }
    }
    const duplicates = [...dupMap.entries()].map(([user_id, regions]) => ({ user_id, regions }));
    const audit = { rawRecords, unique: records.length, duplicateIds: duplicates.length,
      duplicateRows: rawRecords - records.length, writeIns, lockedInPipeline, duplicates: duplicates.slice(0, 300) };

    const plan = allocate(records, { asOf: AS_OF, seed, targets, rounds, overflow, happyFirst, flexOrder, youngFamilyMatch: body.youngFamilyMatch !== false, medicalFirst: body.medicalFirst !== false, regions: scopeRegions });

    // Region totals + a flat per-region row list for the matrix.
    const totalsByArea = {};
    for (const R of REGIONS) for (const k of Object.keys(plan.matrix[R] || {})) totalsByArea[k] = (totalsByArea[k] || 0) + plan.matrix[R][k];

    // Build name/jk lookup so we can return the actual people in each special category.
    const info = new Map();
    for (const R of scopeRegions) for (const v of (recordsByRegion[R] || [])) {
      info.set(String(v.user_id), { name: ((v.first || "") + " " + (v.last || "")).trim(), jk: v.ceremony_jk || "", region: R });
    }
    const CAP = 6000;
    function listFor(pred) {
      const out = [];
      for (const d of plan.decisions) {
        if (!pred(d)) continue;
        const i = info.get(String(d.user_id)) || {};
        out.push({ user_id: d.user_id, name: i.name || "", region: d.region, jk: i.jk || "", age: d.age, bucket: d.bucket, area: d.area, reason: d.reason || null });
        if (out.length >= CAP) break;
      }
      out.sort((a, b) => (a.region + a.name).localeCompare(b.region + b.name));
      return out;
    }
    const lists = {
      iff: listFor(d => d.bucket === "iff"),
      young: listFor(d => d.bucket === "young"),
      youngFamily: listFor(d => d.youngFamily),          // the 5–13s placed with family this run
      contested: listFor(d => d.bucket === "contested"),
      noAge: listFor(d => d.age == null),                    // everyone missing an age, any bucket
      unassigned: listFor(d => d.bucket === "unassigned"),
    };

    const report = {
      mode: commit ? "commit" : "preview", allocMode: incremental ? "incremental" : "full", asOf: plan.asOf, seed: plan.seed,
      event: didar ? { id: didar.id, name: didar.name, regions: scopeRegions } : null,
      total: records.length, affinityTotal: plan.affinityTotal, affinityLeaders: plan.affinityLeaders,
      contestedTotal: plan.contestedTotal, nullAge: plan.nullAge,
      noAgeHeld: plan.decisions.filter(d => d.bucket === "noage").length,
      youngFamilyPlaced: plan.youngFamilyPlaced, youngFamilyByArea: plan.youngFamilyByArea, medicalPlaced: plan.medicalPlaced,
      matrix: plan.matrix, totalsByArea, distReport: plan.distReport,
      withAge: records.filter(r => (r.age != null && Number.isFinite(Number(r.age))) || r.birthday).length,
      audit, lists, listCap: CAP,
    };

    if (!commit) {
      report.note = incremental
        ? "Preview only — INCREMENTAL: everyone who already has an area (review, prior allocation, or a caller list) is kept as-is and counted toward the area targets; only the currently-unassigned pool is distributed by the percentages. Overflow toggle still applies."
        : "Preview only — FULL re-allocation of the whole pool. Kept as-is: review (affinity) assignments, anyone called/accepted/confirmed, and anyone on a caller's list. Targets are a goal for the final mix; areas are filled lowest-% first. Re-run with the same seed to commit the identical plan.";
      context.res = { body: report };
      return;
    }

    // Commit: apply the plan. Affinity records are left untouched.
    const didars = await readDidars();
    const decById = new Map(plan.decisions.map(d => [String(d.user_id), d]));
    for (const region of scopeRegions) {
      await mergeRegion(container, region, (existing) => existing.map(v => {
        if (allocLocked(v)) return v;   // LIVE guard: never touch anyone called/resolved OR on a caller's list
        const d = decById.get(String(v.user_id));
        if (!d || d.bucket === "affinity" || d.bucket === "contested") return v;   // review-touched: leave alone
        if (String(d.region) !== region) return v;   // a stale duplicate copy in another shard — don't re-allocate it
        const nv = { ...v };
        if (d.bucket === "assigned") {
          nv.final_area = d.area; nv.conflict_claims = []; nv.alloc_category = null;
          nv.callable_status = computeCallableStatus(nv);
          nv.event_assignments = seedEventAssignments(nv, didars);
        } else {
          nv.final_area = null; nv.event_assignments = [];
          nv.alloc_category = d.bucket === "young" ? "Young Volunteers"
            : d.bucket === "iff" ? "IFF"
            : d.bucket === "noage" ? "No age on file" : null;
          nv.callable_status = computeCallableStatus(nv);
        }
        nv.activity_log = (nv.activity_log || []).concat([
          { ts: new Date().toISOString(), actor: email || "allocation", action: "allocation", bucket: d.bucket, area: d.area || null, youngFamily: !!d.youngFamily },
        ]);
        return nv;
      }));
    }
    report.note = incremental
      ? `Incremental allocation committed. Only the unassigned pool was distributed; everyone already holding an area (review, prior allocation, or a caller list) was left untouched. ${lockedInPipeline} volunteer(s) called/accepted or on a caller's list were preserved.`
      : `Allocation committed. Assigned people are Stable with a Didar row; Young Volunteers, IFF and no-age people are held aside; review (affinity) assignments were left untouched. ${lockedInPipeline} volunteer(s) already called/accepted or on a caller's list were left exactly as-is.`;
    context.res = { body: report };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
