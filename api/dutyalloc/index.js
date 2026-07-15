// Duty allocation (Phase 4a): give every member of a session a duty, against the minimums imported
// from the area templates. Preview by default; commit writes duty + state onto the session rows.
// Superadmin only — same gate as the area and session allocations.
//
// Fills gaps only: anyone who already holds a duty (allocated / submitted / entered) keeps it. See
// dutyalloc.js for the model. Leads are chosen by the area teams on the review screen, not here.
const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, mergeRegion, REGIONS, readDidars, readSessions } = require("../shared/store");
const { planDuties } = require("./dutyalloc");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";

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
async function readRoster() {
  try {
    const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
    const b = c.getBlockBlobClient("session-duties.json");
    if (!(await b.exists())) return {};
    const o = JSON.parse(await streamToString((await b.download()).readableStreamBody));
    return (o && o.sessions) || {};
  } catch { return {}; }
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const sessions = await readSessions(null);
    if (req.method === "GET") {
      const roster = await readRoster();
      context.res = { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessions: sessions.map(s => ({ id: s.id, name: s.name, parent: s.parent,
          areasWithRoster: Object.keys(roster[s.id] || {}).sort() })) }) };
      return;
    }

    const body = req.body || {};
    const commit = !!body.commit;
    const sessionId = String(body.session || "").trim();
    const session = sessions.find(s => String(s.id) === sessionId);
    if (!session) { context.res = { status: 400, body: { error: "Pick a session." } }; return; }

    const roster = (await readRoster())[sessionId] || {};
    if (!Object.keys(roster).length) {
      context.res = { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `No duty roster has been imported for \u201c${session.name}\u201d yet \u2014 do that on the Duty rosters screen first.` }) };
      return;
    }
    // The session's people live in its Didar's regions.
    const didars = await readDidars();
    const didar = didars.find(d => String(d.id) === String(session.parent));
    const scopeRegions = didar ? REGIONS.filter(R => (didar.regions || []).includes(R)) : REGIONS;

    const container = await getContainer(DATA_CONTAINER);
    const all = [];
    for (const R of scopeRegions) {
      const { records } = await readRegion(container, R);
      for (const v of records) all.push(v);
    }

    const plan = planDuties(all, roster, {
      sessionId, seed: body.seed != null ? Number(body.seed) : 1234567,
      area: body.area ? String(body.area) : null,
    });

    const report = {
      mode: commit ? "commit" : "preview",
      session: sessionId, sessionName: session.name, regions: scopeRegions,
      counts: plan.counts, areas: plan.areas, areasWithoutRoster: plan.areasWithoutRoster,
      shortfallTotal: plan.shortfallTotal, changed: plan.changes.length,
      note: commit
        ? "Applied. Every unassigned member of this session now has a duty, ready for the areas to review."
        : "Preview only \u2014 nothing written. Anyone who already holds a duty keeps it; only people without one are placed.",
    };

    if (!commit) {
      context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) };
      return;
    }

    const byRegion = {};
    for (const c of plan.changes) (byRegion[c.region] = byRegion[c.region] || new Map()).set(String(c.user_id), c);
    const ts = new Date().toISOString();
    report.written = {};
    for (const R of scopeRegions) {
      const m = byRegion[R];
      if (!m || !m.size) { report.written[R] = 0; continue; }
      let n = 0;
      await mergeRegion(container, R, (existing) => existing.map(v => {
        const c = m.get(String(v.user_id));
        if (!c) return v;
        n++;
        const log = Array.isArray(v.activity_log) ? v.activity_log.slice() : [];
        log.push({ ts, actor: email || "dutyalloc", action: "duty_allocation", event: sessionId, area: c.area, duty: c.duty });
        return { ...v, event_assignments: c.rows, activity_log: log };
      }));
      report.written[R] = n;
    }
    context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) };
  } catch (err) {
    context.log && context.log.error && context.log.error("dutyalloc failed:", (err && err.stack) || err);
    context.res = { status: 500, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String((err && err.message) || err) }) };
  }
};
