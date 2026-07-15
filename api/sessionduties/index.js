// Per-session duty rosters (Phase 3). GET returns the committed roster; POST previews or commits an
// import of the filled-in area templates.
//
// The templates are generated and parsed IN THE BROWSER (SheetJS, same as the BI import) — this
// endpoint receives already-extracted cell values and does the parsing/planning here, where it is
// unit-tested. Preview by default: nothing is written until commit.
//
// Commit writes two blobs, in this order:
//   1. duties.json        — duties typed at the bottom of a template, added to the MASTER catalog so
//                           callers can capture interest in them and Phase 4 can allocate them.
//   2. session-duties.json — {sessions: {sessionId: {area: [{duty,min,leads,checkIn}]}}}, the
//                           per-session requirement. "Remove" only affects the session it was marked in.
const { BlobServiceClient } = require("@azure/storage-blob");
const { readSessions } = require("../shared/store");
const { AREAS, clean } = require("../shared/duties");
const { planRoster } = require("./roster");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
const ROSTER_BLOB = "session-duties.json";
const DUTIES_BLOB = "duties.json";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
function emailOf(p) {
  if (!p) return null;
  let e = p.userDetails || null;
  if (!e && Array.isArray(p.claims)) {
    const c = p.claims.find(c => /(emailaddress|email|preferred_username|upn)$/i.test(c.typ || c.type || ""));
    if (c) e = c.val || c.value;
  }
  return e ? String(e).toLowerCase() : null;
}
function streamToString(s) {
  return new Promise((res, rej) => {
    const ch = []; s.on("data", d => ch.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(ch).toString("utf8"))); s.on("error", rej);
  });
}
async function container() {
  const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
  await c.createIfNotExists();
  return c;
}
async function readJson(c, name, fallback) {
  const b = c.getBlockBlobClient(name);
  if (!(await b.exists())) return fallback;
  try { return JSON.parse(await streamToString((await b.download()).readableStreamBody)); }
  catch { return fallback; }
}
async function writeJson(c, name, obj) {
  const b = c.getBlockBlobClient(name);
  const body = JSON.stringify(obj, null, 2);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, overwrite: true });
}
const normStore = (o) => (o && typeof o === "object" && o.sessions && typeof o.sessions === "object")
  ? o : { sessions: {} };

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isAdmin = roles.includes("superadmin") || roles.includes("admin");
    if (!email) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = await container();
    const sessions = await readSessions(null);          // every session, across both Didars
    const store = normStore(await readJson(c, ROSTER_BLOB, null));
    const catalog = await readJson(c, DUTIES_BLOB, []);

    if (req.method === "GET") {
      // Readable by any signed-in role: Phase 4 and the duty screens need the roster.
      context.res = { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roster: store.sessions, sessions, duties: catalog, areas: AREAS,
          canManage: isAdmin, updatedAt: store.updatedAt || null, updatedBy: store.updatedBy || null }) };
      return;
    }

    if (req.method === "POST") {
      if (!isAdmin) { context.res = { status: 403, body: { error: "Only an admin can import duty rosters." } }; return; }
      const body = req.body || {};
      const commit = !!body.commit;
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) { context.res = { status: 400, body: { error: "No template files were read." } }; return; }
      if (!sessions.length) { context.res = { status: 400, body: { error: "No sessions are configured — add them on the Events screen first." } }; return; }

      const plan = planRoster(files, catalog, sessions, { areas: AREAS });
      const report = {
        mode: commit ? "commit" : "preview",
        counts: plan.counts, summary: plan.summary, removed: plan.removed,
        problems: plan.problems.slice(0, 500), problemCount: plan.problems.length,
        warnings: plan.warnings.slice(0, 500), warningCount: plan.warnings.length,
        newDuties: plan.newDuties, areasTouched: plan.areasTouched,
        note: commit
          ? "Applied. The per-session duty rosters are saved and any new duties were added to the catalog."
          : "Preview only — nothing saved. Check the parsed check-in times and the new duties below before committing.",
      };

      if (!commit) {
        context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) };
        return;
      }

      // 1) master catalog: add the duties teams typed at the bottom of their templates.
      if (plan.newDuties.length) {
        const next = catalog.slice();
        for (const d of plan.newDuties) {
          if (!next.some(x => clean(x.area) === clean(d.area) && clean(x.name).toLowerCase() === clean(d.name).toLowerCase())) next.push(d);
        }
        await writeJson(c, DUTIES_BLOB, next);
        report.catalogAdded = plan.newDuties.length;
      } else report.catalogAdded = 0;

      // 2) the per-session roster. Only the session x area cells covered by these files are replaced —
      //    importing one area's template must never wipe another area's roster.
      const out = { sessions: JSON.parse(JSON.stringify(store.sessions || {})) };
      for (const sid of Object.keys(plan.roster)) {
        out.sessions[sid] = out.sessions[sid] || {};
        for (const area of Object.keys(plan.roster[sid])) {
          out.sessions[sid][area] = plan.roster[sid][area].map(r => ({ duty: r.duty, min: r.min, leads: r.leads, checkIn: r.checkIn }));
        }
      }
      // An area whose template listed only removals for a session ends up with no rows: clear the cell.
      for (const r of plan.removed) {
        const cell = (out.sessions[r.session] || {})[r.area];
        if (cell) {
          const kept = cell.filter(x => clean(x.duty).toLowerCase() !== clean(r.duty).toLowerCase());
          if (kept.length) out.sessions[r.session][r.area] = kept;
          else delete out.sessions[r.session][r.area];
        }
      }
      out.updatedAt = new Date().toISOString();
      out.updatedBy = email;
      await writeJson(c, ROSTER_BLOB, out);
      report.roster = out.sessions;
      context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log && context.log.error && context.log.error("sessionduties failed:", (err && err.stack) || err);
    context.res = { status: 500, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String((err && err.message) || err) }) };
  }
};
