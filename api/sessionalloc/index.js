// Session allocation (Phase 2): place ACCEPTED volunteers into the session whose Jamatkhana list
// contains their ceremony_jk, carrying their area. Preview by default; commit writes event_assignments.
// Scoped to one Didar (its sessions partition its JKs), superadmin only — same gate as api/allocate.
//
// This is a SYNC per Didar, not a per-session append: running it after a JK mapping change converges.
// See sessalloc.js for the model. Support volunteers are Phase 4 and are never invented here.
const { getContainer, readRegion, mergeRegion, REGIONS, readDidars, readSessions } = require("../shared/store");
const { isAcceptedVolunteer } = require("../shared/rollup");
const { planSessions } = require("./sessalloc");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) {
      context.res = { status: 403, body: { error: "Not authorized." } }; return;
    }
    const body = req.body || {};
    const commit = !!body.commit;
    const eventId = String(body.event || "").trim();
    if (!eventId) { context.res = { status: 400, body: { error: "Pick a Didar to allocate sessions for." } }; return; }

    const didars = await readDidars();
    const didar = didars.find(d => d.id === eventId);
    if (!didar) { context.res = { status: 400, body: { error: "Didar not found (or it's inactive)." } }; return; }

    const sessions = await readSessions(didar.id);
    if (!sessions.length) {
      context.res = { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `“${didar.name}” has no sessions yet. Add them on the Events screen, with their Jamatkhanas.` }) };
      return;
    }
    // A Didar's regions are the scope: a person's region comes from their stored region field.
    const scopeRegions = REGIONS.filter(R => (didar.regions || []).includes(R));
    if (!scopeRegions.length) {
      context.res = { status: 400, body: { error: `“${didar.name}” has no regions set. Set them on the Events screen.` } }; return;
    }

    const container = await getContainer(DATA_CONTAINER);
    const recordsByRegion = {};
    await Promise.all(scopeRegions.map(async (R) => {
      recordsByRegion[R] = (await readRegion(container, R)).records || [];
    }));
    const all = [];
    for (const R of scopeRegions) for (const v of recordsByRegion[R]) all.push(v);

    const plan = planSessions(all, sessions, { isAccepted: isAcceptedVolunteer });

    const report = {
      mode: commit ? "commit" : "preview",
      event: didar.id, eventName: didar.name, regions: scopeRegions,
      counts: plan.counts, sessions: plan.sessions, areasPresent: plan.areasPresent,
      duplicateJks: plan.duplicateJks, unmappedJks: plan.unmappedJks,
      noJkList: plan.noJkList, noAreaList: plan.noAreaList, staleList: plan.staleList,
      changed: plan.changes.length,
      note: commit
        ? "Applied. Accepted volunteers are now in the session their Jamatkhana belongs to, carrying their area. Support volunteers come later (Phase 4)."
        : "Preview only — nothing written. Shows the roster each session would get, and every Jamatkhana that still needs mapping.",
    };

    if (!commit) {
      context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) };
      return;
    }

    // Commit: one merge per region, applying the planned rows by user_id.
    const byRegion = {};
    for (const c of plan.changes) (byRegion[c.region] = byRegion[c.region] || new Map()).set(String(c.user_id), c.rows);
    const ts = new Date().toISOString();
    report.written = {};
    for (const R of scopeRegions) {
      const m = byRegion[R];
      if (!m || !m.size) { report.written[R] = 0; continue; }
      let n = 0;
      await mergeRegion(container, R, (existing) => existing.map(v => {
        const rows = m.get(String(v.user_id));
        if (!rows) return v;
        n++;
        const log = Array.isArray(v.activity_log) ? v.activity_log.slice() : [];
        log.push({ ts, actor: email || "sessionalloc", action: "session_allocation", event: didar.id,
          sessions: rows.filter(r => r && r.basis === "session").map(r => r.event) });
        return { ...v, event_assignments: rows, activity_log: log };
      }));
      report.written[R] = n;
    }
    context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) };
  } catch (err) {
    context.log && context.log.error && context.log.error("sessionalloc failed:", (err && err.stack) || err);
    context.res = { status: 500, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String((err && err.message) || err) }) };
  }
};
