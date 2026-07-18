// Recategorise duties between areas (the DA migration): GET the pickable areas + duties, POST a
// preview or a commit. Superadmin only — it rewrites the catalog, the roster, and people's areas in
// one shot, and there is no per-area scoping that makes sense for a cross-area move.
//
// The plan comes from the pure planMigration; this endpoint is the I/O around it: read three blobs,
// plan, and on commit replay exactly what the plan described. Preview and commit call the SAME
// planner, so what you approve is what runs.
const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, mutateVolunteer, REGIONS, readSessions } = require("../shared/store");
const { AREAS, clean, norm } = require("../shared/duties");
const { planMigration, theSessionRow } = require("../shared/migrate");
const { LOCKED_STATES } = require("../dutyalloc/dutyalloc");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const ROSTER_BLOB = "session-duties.json";
const DUTIES_BLOB = "duties.json";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
async function configContainer() { return BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER); }
async function readJson(c, name, dflt) {
  try {
    const b = c.getBlockBlobClient(name);
    const buf = await b.downloadToBuffer();
    return JSON.parse(buf.toString("utf8"));
  } catch { return dflt; }
}
async function writeJson(c, name, obj) {
  const body = JSON.stringify(obj, null, 2);
  await c.getBlockBlobClient(name).upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: "application/json" } });
}

module.exports = async function (context, req) {
  try {
    const p = getPrincipal(req);
    const email = String((p && p.userDetails) || "").toLowerCase();
    const roles = (p && p.userRoles) || [];
    if (!email) { context.res = { status: 401, body: { error: "Not signed in." } }; return; }
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Recategorising duties is a Super Admin action." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const cfg = await configContainer();
    const catalog = await readJson(cfg, DUTIES_BLOB, []);
    const roster = await readJson(cfg, ROSTER_BLOB, { sessions: {} });
    const sessions = await readSessions(null);
    const sessName = (id) => (sessions.find(s => String(s.id) === String(id)) || {}).name || id;

    // ---- GET: what can be moved -----------------------------------------------------------------
    if (req.method !== "POST") {
      // Duties grouped by the area they currently sit in, so the screen can offer "move these OUT of X".
      const byArea = {};
      for (const a of AREAS) byArea[a] = [];
      for (const d of catalog) { const a = clean(d.area); if (byArea[a]) byArea[a].push(clean(d.name)); }
      for (const a of AREAS) byArea[a].sort();
      context.res = { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areas: AREAS, dutiesByArea: byArea }) };
      return;
    }

    // ---- POST: preview or commit ----------------------------------------------------------------
    const body = req.body || {};
    const commit = body.commit === true;
    const from = clean(body.from), to = clean(body.to);
    const duties = Array.isArray(body.duties) ? body.duties : [];
    if (from && !AREAS.includes(from)) { context.res = { status: 400, body: { error: "Unknown source area." } }; return; }
    if (to && !AREAS.includes(to)) { context.res = { status: 400, body: { error: "Unknown target area." } }; return; }

    // Every volunteer, once — the plan needs the whole population to find who is connected.
    const data = await getContainer(DATA_CONTAINER);
    const all = [];
    for (const R of REGIONS) { const { records } = await readRegion(data, R); for (const v of records) all.push(v); }

    const plan = planMigration(all, catalog, roster, { from, to, duties,
      lockedStates: LOCKED_STATES, sessionName: sessName });

    if (plan.errors.length) { context.res = { status: 400, body: { error: plan.errors.join(" ") } }; return; }

    const summary = () => {
      const c = plan.counts;
      const bits = [];
      bits.push(`${c.dutiesMoving} dut${c.dutiesMoving === 1 ? "y" : "ies"} ${commit ? "moved" : "will move"} to ${to}` +
        (c.rosterRows ? ` (${c.rosterRows} roster row${c.rosterRows === 1 ? "" : "s"})` : "") + ".");
      if (c.peopleMoving) bits.push(`${c.peopleMoving} volunteer${c.peopleMoving === 1 ? "" : "s"} ${commit ? "moved" : "will move"} with them` +
        (c.peopleKeepingDuty ? `, ${c.peopleKeepingDuty} keeping their duty` : "") + ".");
      if (c.leftBehind) bits.push(`${c.leftBehind} interested but committed to a duty that isn't moving \u2014 left in ${from}.`);
      if (c.dutiesBlocked) bits.push(`${c.dutiesBlocked} dut${c.dutiesBlocked === 1 ? "y" : "ies"} could NOT move (see below).`);
      if (c.stranded) bits.push(`${c.stranded} volunteer${c.stranded === 1 ? " is" : "s are"} stuck behind a blocked duty.`);
      if (c.biCorrections) bits.push(`${c.biCorrections} ${commit ? "were" : "will be"} flagged for a Better Impact committee correction.`);
      return bits.join(" ");
    };

    if (!commit) {
      context.res = { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, preview: true, plan, note: "Preview only \u2014 nothing saved. " + summary() }) };
      return;
    }

    // ---- COMMIT. Order matters: catalog, then roster, then people. If the people loop dies part way,
    //      the survivors hold a moving duty while still labelled the old area — which the review screen
    //      shows as off-roster and a re-run of this migration finishes. The reverse order would leave
    //      people correctly moved but their duty missing from either roster.
    // 1) catalog: repoint each moving duty's area.
    const movingSet = new Set(plan.duties.willMove.map(norm));
    for (const d of catalog) {
      if (clean(d.area) === from && movingSet.has(norm(d.name))) d.area = to;
    }
    await writeJson(cfg, DUTIES_BLOB, catalog);

    // 2) roster: pull each moving row out of the source cell into the target, per session.
    const out = roster && roster.sessions ? roster : { sessions: {} };
    for (const mv of plan.rosterMoves) {
      const cell = (out.sessions[mv.session] || {})[from] || [];
      const at = cell.findIndex(r => norm(r.duty) === norm(mv.duty));
      if (at < 0) continue;                          // already gone — idempotent
      const [row] = cell.splice(at, 1);
      out.sessions[mv.session][to] = out.sessions[mv.session][to] || [];
      if (!out.sessions[mv.session][to].some(r => norm(r.duty) === norm(mv.duty))) out.sessions[mv.session][to].push(row);
      if (!cell.length) delete out.sessions[mv.session][from];   // no empty cells
    }
    out.updatedAt = new Date().toISOString();
    out.updatedBy = email;
    await writeJson(cfg, ROSTER_BLOB, out);

    // 3) people: move final_area AND the session row's area together. Keep the moving duty if they had
    //    one; keep acceptance untouched; flag a BI committee correction for anyone already entered.
    let movedCount = 0, moveSkipped = 0;
    for (const m of plan.people.move) {
      const res = await mutateVolunteer(data, m.region, m.user_id, (v) => {
        // Re-check under the write: they may have changed between preview and commit.
        if (clean(v.final_area) !== from) return { skip: true };
        const sr = theSessionRow(v);
        if (m.keepsDuty) {
          if (!sr || norm(sr.duty) !== norm(m.duty)) return { skip: true };   // duty changed under us
          if (LOCKED_STATES.includes(clean(sr.state))) return { skip: true }; // became locked
        }
        v.final_area = to;
        if (sr) sr.area = to;                        // the review screen reads THIS
        if (v.ivol_entered) {
          v.bi_correction_needed = true;
          v.bi_correction_reason = "area_recategorized";   // committee change, NOT a reopen
        }
        v.activity_log = v.activity_log || [];
        v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "area_recategorized",
          from, to, duty: m.keepsDuty ? m.duty : "" });
      });
      if (res.ok && !(res.extra || {}).skip) movedCount++; else moveSkipped++;
    }

    context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      ok: true, committed: true,
      dutiesMoved: plan.duties.willMove.length, rosterRowsMoved: plan.rosterMoves.length,
      peopleMoved: movedCount, moveSkipped, blocked: plan.duties.blocked,
      leftBehind: plan.counts.leftBehind, stranded: plan.counts.stranded, biCorrections: plan.counts.biCorrections,
      note: summary() + (moveSkipped ? ` ${moveSkipped} volunteer(s) had changed since the preview and were skipped \u2014 re-run to catch them.` : "") }) };
  } catch (e) {
    context.log && context.log.error && context.log.error("migrateduties failed", (e && e.stack) || e);
    context.res = { status: 500, body: { error: String((e && e.message) || e) } };
  }
};
