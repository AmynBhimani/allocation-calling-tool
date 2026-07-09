// READ-ONLY forensics. Answers two questions before anyone restores anything:
//   1. How many UNRESOLVED volunteers did each caller hold at each of the last N backups?
//      (a column per snapshot — you can see exactly which backup the drop happened between)
//   2. For a chosen snapshot, where is each of those people NOW?
//      stillWithCaller / nowUnassigned / nowOtherCaller / nowResolved / notFound
//
// Resolved volunteers (Accepted / Withdrew / Duplicate) are counted separately and never treated as
// restorable — that work is finished and their assigned_caller is what attributes it.
//
//   /api/assignmentaudit?before=2026-07-08T16:00:00Z&n=3
//        -> the 3 most recent snapshots at/before that instant, per-caller pending counts + live
//   /api/assignmentaudit?before=...&n=3&caller=a@x.ca,b@x.ca      -> only these callers
//   /api/assignmentaudit?snapshot=2026-07-08T15-14-23Z&detail=1&caller=a@x.ca
//        -> per-volunteer rows: who they were with then, where they are now
//   Optional filters: &region=Prairies &area=Seniors%20%26%20Mobility
//
// Writes nothing, ever. Safe to run during peak calling.
const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, REGIONS, readRolesStore } = require("../shared/store");
const { listSnapshotStamps, readSnapshotRegion, stampToDate, pickStampsBefore } = require("../shared/snapshots");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const RESOLVED_OUTCOMES = ["Accepted", "Withdrew", "Duplicate"];
const isResolved = (v) => RESOLVED_OUTCOMES.includes(v.call_outcome);

const clean = (s) => String(s == null ? "" : s).trim();
const lc = (s) => clean(s).toLowerCase();
const nm = (v) => ((v.first || "") + " " + (v.last || "")).trim() || "(no name)";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const roles = (getPrincipal(req) || {}).userRoles || [];
    if (!(roles.includes("superadmin") || roles.includes("admin"))) {
      context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return;
    }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const q = req.query || {};
    const callerFilter = new Set(lc(q.caller).split(",").map(s => s.trim()).filter(Boolean));
    const areaFilter = clean(q.area);
    const regionParam = clean(q.region);
    if (regionParam && !REGIONS.includes(regionParam)) { context.res = { status: 400, body: { error: "Unknown region." } }; return; }

    const svc = BlobServiceClient.fromConnectionString(CONN);
    const allStamps = await listSnapshotStamps(svc);
    if (!allStamps.length) { context.res = { status: 404, body: { error: "No snapshots found." } }; return; }

    // Which snapshots to examine.
    let stamps;
    if (clean(q.snapshot)) {
      stamps = [clean(q.snapshot)];
      if (!allStamps.includes(stamps[0])) { context.res = { status: 404, body: { error: `Snapshot ${stamps[0]} not found. Use /api/restorecaller?list=1.` } }; return; }
    } else if (clean(q.before)) {
      const t = Date.parse(clean(q.before));
      if (!Number.isFinite(t)) { context.res = { status: 400, body: { error: "before= must be an ISO timestamp, e.g. 2026-07-08T16:00:00Z" } }; return; }
      stamps = pickStampsBefore(allStamps, t, Math.min(6, Math.max(1, parseInt(q.n, 10) || 3)));
      if (!stamps.length) { context.res = { status: 404, body: { error: "No snapshots at or before that time." } }; return; }
    } else {
      context.res = { status: 400, body: { error: "Pass ?before=<ISO>&n=3 (survey) or ?snapshot=<stamp>&detail=1 (drill-down)." } }; return;
    }

    // Narrow the regions we read: an explicit region wins; otherwise the regions the named callers work.
    let regions = regionParam ? [regionParam] : REGIONS.slice();
    if (!regionParam && callerFilter.size) {
      const store = await readRolesStore();
      const r = [...new Set(store.filter(a => callerFilter.has(lc(a.email)) && clean(a.role) === "caller").map(a => clean(a.region)).filter(Boolean))];
      if (r.length) regions = r;
    }

    const keep = (v) => (!areaFilter || clean(v.final_area) === areaFilter);

    // ---- Live state, read once ----
    const container = await getContainer(DATA_CONTAINER);
    const live = {};
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      const m = new Map(); for (const v of records) m.set(String(v.user_id), v);
      live[region] = m;
    }

    // ---- Per-snapshot survey ----
    const survey = [];
    const detailRows = [];
    const wantDetail = q.detail === "1" || q.detail === "true";

    for (const stamp of stamps) {
      const perCaller = {};
      const touch = (c) => (perCaller[c] = perCaller[c] || { pendingThen: 0, resolvedThen: 0, stillWithCaller: 0, nowUnassigned: 0, nowOtherCaller: 0, nowResolved: 0, notFound: 0 });

      for (const region of regions) {
        for (const v of await readSnapshotRegion(svc, region, stamp)) {
          const c = lc(v.assigned_caller);
          if (!c) continue;
          if (callerFilter.size && !callerFilter.has(c)) continue;
          if (!keep(v)) continue;

          const row = touch(c);
          if (isResolved(v)) { row.resolvedThen++; continue; }   // finished work — safe, not restorable
          row.pendingThen++;

          const now = live[region] && live[region].get(String(v.user_id));
          let where;
          if (!now) { row.notFound++; where = "notFound"; }
          else if (isResolved(now)) { row.nowResolved++; where = "nowResolved"; }
          else {
            const nc = lc(now.assigned_caller);
            if (nc === c) { row.stillWithCaller++; where = "stillWithCaller"; }
            else if (!nc) { row.nowUnassigned++; where = "nowUnassigned"; }
            else { row.nowOtherCaller++; where = "nowOtherCaller"; }
          }
          if (wantDetail && stamps.length === 1 && detailRows.length < 1000) {
            detailRows.push({
              user_id: v.user_id, name: nm(v), region, area: v.final_area || "",
              callerThen: c, where,
              callerNow: now ? (lc(now.assigned_caller) || null) : null,
              outcomeNow: now ? (now.call_outcome || null) : null,
            });
          }
        }
      }

      const totals = Object.values(perCaller).reduce((a, r) => {
        for (const k of Object.keys(r)) a[k] = (a[k] || 0) + r[k];
        return a;
      }, {});
      survey.push({ snapshot: stamp, at: (stampToDate(stamp) || {}).toISOString ? stampToDate(stamp).toISOString() : stamp, callers: Object.keys(perCaller).length, totals, perCaller });
    }

    context.res = {
      body: {
        readOnly: true,
        regionsScanned: regions,
        filters: { caller: [...callerFilter], area: areaFilter || null, region: regionParam || null },
        snapshotsExamined: stamps,
        legend: {
          pendingThen: "unresolved and assigned to this caller at that snapshot — the restorable population",
          resolvedThen: "Accepted/Withdrew/Duplicate at that snapshot — finished, never touched",
          stillWithCaller: "still assigned to them now — nothing to do",
          nowUnassigned: "cleared and sitting in the pool — restorecaller can give these back",
          nowOtherCaller: "now held by a DIFFERENT caller — restorecaller will SKIP these; needs a decision",
          nowResolved: "someone has since called and settled them — leave alone",
        },
        survey,
        detail: wantDetail ? (stamps.length === 1 ? detailRows : "detail=1 requires a single &snapshot=") : undefined,
        note: "Nothing was written. Compare pendingThen across snapshots to find when the drop happened.",
      }
    };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
