const { BlobServiceClient } = require("@azure/storage-blob");
const { fetchAllUsers } = require("./bi");
const { allocate } = require("./allocate");
const { normalize, WESTERN_JKS, REGIONS } = require("./fields");

const CONN = process.env.RESPONSES_STORAGE;
const BI_USER = process.env.BI_API_USER;
const BI_PASS = process.env.BI_API_PASS;
const BI_BASE = process.env.BI_API_BASE || "https://api.betterimpact.com/v1/enterprise/users/";

// ---------- helpers ----------
function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
function streamToString(s) {
  return new Promise((res, rej) => {
    const ch = []; s.on("data", d => ch.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(ch).toString("utf8"))); s.on("error", rej);
  });
}
async function readShard(container, region) {
  const b = container.getBlockBlobClient(`volunteers-${region}.json`);
  if (!(await b.exists())) return [];
  try { return JSON.parse(await streamToString((await b.download()).readableStreamBody)); }
  catch { return []; }
}
async function writeShard(container, region, arr) {
  const b = container.getBlockBlobClient(`volunteers-${region}.json`);
  const body = JSON.stringify(arr);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, overwrite: true });
}

// A volunteer is "touched" (call state to preserve) if reconciliation/calling has acted on them.
function isTouched(v) {
  return (Array.isArray(v.activity_log) && v.activity_log.length > 0) || !!v.assigned_caller || !!v.ivol_entered;
}

// ---------- main ----------
module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }
    if (!BI_USER || !BI_PASS) { context.res = { status: 500, body: { error: "BI_API_USER / BI_API_PASS not set." } }; return; }

    const mode = (req.query.mode || "dry").toLowerCase();           // 'dry' (default) or 'commit'
    const targetContainer = mode === "commit" ? "tool-data" : "tool-data-dryrun";

    // 1) Pull all enterprise users, normalize, filter to the 27 JKs.
    const western = [];
    let scanned = 0;
    const t0 = Date.now();
    const { pages, total } = await fetchAllUsers({
      base: BI_BASE, user: BI_USER, pass: BI_PASS, pageSize: 250, maxPages: 250,
      onBatch: (users) => {
        scanned += users.length;
        for (const u of users) {
          const r = normalize(u);
          if (r.jk && WESTERN_JKS.has(r.jk)) western.push(r);
        }
      }
    });

    // 2) Run the validated allocation engine over the western batch.
    const alloc = allocate(western);
    const allocById = new Map(alloc.map(a => [a.user_id, a]));

    // 3) Build fresh records, grouped by region.
    const byRegion = { BC: [], Prairies: [], Edmonton: [] };
    for (const r of western) {
      const a = allocById.get(r.user_id) || {};
      const region = REGIONS.includes(a.region) ? a.region : null;
      if (!region) continue; // skip anything whose region isn't one of the three (shouldn't happen for the 27)
      byRegion[region].push({
        user_id: r.user_id, first: r.first, last: r.last, email: r.email, username: r.username,
        cell_phone: r.cell_phone, home_phone: r.home_phone, work_phone: r.work_phone,
        ceremony_jk: r.jk, region,
        list: a.list || null,
        computed_area: a.computed_area, final_area: a.computed_area,
        held_aside: !!a.held_aside,
        affinity_flag: false, leader_flag: false, conflict_claims: [],
        never_reviewed: true, new_since_sync: true,
        callable_status: a.held_aside ? "Unassigned" : "Stable",
        assigned_caller: null, ivol_entered: false, activity_log: []
      });
    }

    // 4) Upsert into the target container, preserving call state on commit.
    const svc = BlobServiceClient.fromConnectionString(CONN);
    const container = svc.getContainerClient(targetContainer);
    await container.createIfNotExists();

    const summary = { mode, target: targetContainer, scanned, biTotal: total, pages,
      western: western.length, added: 0, preserved: 0, refreshed: 0, byRegion: {}, byArea: {}, byStatus: {} };

    for (const region of REGIONS) {
      const fresh = byRegion[region];
      let existing = [];
      if (mode === "commit") existing = await readShard(container, region);
      const exById = new Map(existing.map(v => [v.user_id, v]));

      const merged = fresh.map(nv => {
        const old = exById.get(nv.user_id);
        if (old && mode === "commit" && isTouched(old)) {
          // preserve reconciliation/calling state; refresh contact + recomputed allocation + (later) flags
          summary.preserved++;
          return {
            ...old,
            first: nv.first, last: nv.last, email: nv.email, username: nv.username,
            cell_phone: nv.cell_phone, home_phone: nv.home_phone, work_phone: nv.work_phone,
            ceremony_jk: nv.ceremony_jk, region: nv.region,
            list: nv.list, computed_area: nv.computed_area, held_aside: nv.held_aside,
            new_since_sync: false
            // final_area, callable_status, assigned_caller, ivol_entered, activity_log, flags: kept from old
          };
        }
        if (old) { summary.refreshed++; return { ...nv, new_since_sync: false,
          affinity_flag: old.affinity_flag, leader_flag: old.leader_flag, conflict_claims: old.conflict_claims || [] }; }
        summary.added++;
        return nv;
      });

      await writeShard(container, region, merged);
      summary.byRegion[region] = merged.length;
      for (const v of merged) {
        if (v.computed_area) summary.byArea[v.computed_area] = (summary.byArea[v.computed_area] || 0) + 1;
        summary.byStatus[v.callable_status] = (summary.byStatus[v.callable_status] || 0) + 1;
      }
    }

    summary.elapsed_ms = Date.now() - t0;
    summary.note = mode === "dry"
      ? "DRY RUN — wrote to tool-data-dryrun. Inspect, then re-run with ?mode=commit to write real data."
      : "COMMIT — wrote to tool-data with call-state preservation.";
    context.res = { body: summary };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
