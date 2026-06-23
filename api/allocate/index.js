const { getContainer, readRegion, mergeRegion, REGIONS, readDidars } = require("../shared/store");
const { computeCallableStatus, seedEventAssignments } = require("../shared/status");
const { allocate, DEFAULT_STRIP } = require("./alloc");

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
    const strip = (body.strip && typeof body.strip === "object") ? body.strip : DEFAULT_STRIP;

    // Read all shards and assemble the engine's input records.
    const container = await getContainer(DATA_CONTAINER);
    const recordsByRegion = {};
    const records = [];
    for (const region of REGIONS) {
      const { records: rs } = await readRegion(container, region);
      recordsByRegion[region] = rs;
      for (const v of rs) {
        records.push({
          user_id: v.user_id, region,
          computed_area: v.computed_area || null, final_area: v.final_area || null,
          never_reviewed: !!v.never_reviewed, leader_flag: !!v.leader_flag,
          list: v.list || null, interfaith: !!v.interfaith, birthday: v.birthday || null,
        });
      }
    }

    const plan = allocate(records, { asOf: AS_OF, seed, strip });

    // Region totals + a flat per-region row list for the matrix.
    const totalsByArea = {};
    for (const R of REGIONS) for (const k of Object.keys(plan.matrix[R] || {})) totalsByArea[k] = (totalsByArea[k] || 0) + plan.matrix[R][k];

    const report = {
      mode: commit ? "commit" : "preview", asOf: plan.asOf, seed: plan.seed, strip,
      total: records.length, affinityTotal: plan.affinityTotal, affinityLeaders: plan.affinityLeaders,
      nullAge: plan.nullAge, matrix: plan.matrix, totalsByArea,
      stripReport: plan.stripReport, distReport: plan.distReport,
      withBirthday: records.filter(r => r.birthday).length,
    };

    if (!commit) {
      report.note = "Preview only — nothing written. Affinity = anyone already assigned a final area by the review load (kept as-is). Re-run with the same seed to commit the identical plan.";
      context.res = { body: report };
      return;
    }

    // Commit: apply the plan. Affinity records are left untouched.
    const didars = await readDidars();
    const decById = new Map(plan.decisions.map(d => [String(d.user_id), d]));
    for (const region of REGIONS) {
      await mergeRegion(container, region, (existing) => existing.map(v => {
        const d = decById.get(String(v.user_id));
        if (!d || d.bucket === "affinity") return v;
        const nv = { ...v };
        if (d.bucket === "assigned" || d.bucket === "kept") {
          nv.final_area = d.area; nv.conflict_claims = []; nv.alloc_category = null;
          nv.callable_status = computeCallableStatus(nv);
          nv.event_assignments = seedEventAssignments(nv, didars);
        } else {
          nv.final_area = null; nv.event_assignments = [];
          nv.alloc_category = d.bucket === "young" ? "Young Volunteers" : d.bucket === "iff" ? "IFF" : null;
          nv.callable_status = computeCallableStatus(nv);
        }
        nv.activity_log = (nv.activity_log || []).concat([
          { ts: new Date().toISOString(), actor: email || "allocation", action: "allocation", bucket: d.bucket, area: d.area || null },
        ]);
        return nv;
      }));
    }
    report.note = "Allocation committed. Assigned people are Stable with a Didar row; Young Volunteers and IFF are held in their own categories; affinity assignments were left untouched.";
    context.res = { body: report };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
