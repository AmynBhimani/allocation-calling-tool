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
const { readSessions, getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");
const { sessionRow, LOCKED_STATES } = require("../dutyalloc/dutyalloc");
const { AREAS, clean, norm } = require("../shared/duties");
const { planRoster, parseRemove } = require("./roster");

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

// Who is already DOING each duty: (session, area, duty) -> the people holding it. Read only for a
// POST — the GET is on every page load and this walks every region. The index is what makes the
// Remove guard possible at all: the roster blobs alone cannot tell you whether a duty is in use.
async function buildHolderIndex() {
  const idx = new Map();
  const data = await getContainer(DATA_CONTAINER);
  for (const region of REGIONS) {
    const { records } = await readRegion(data, region);
    for (const v of records) {
      for (const r of (Array.isArray(v.event_assignments) ? v.event_assignments : [])) {
        if (!r || r.basis !== "session") continue;          // only session rows carry a duty
        const duty = clean(r.duty); if (!duty) continue;
        const key = String(r.event) + "|" + clean(r.area) + "|" + norm(duty);
        if (!idx.has(key)) idx.set(key, []);
        idx.get(key).push({
          user_id: v.user_id, region,          // region is how the commit reaches them to clear it
          name: ((v.first || "") + " " + (v.last || "")).trim() || String(v.user_id),
          state: clean(r.state),
        });
      }
    }
  }
  return idx;
}

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

      // Under replace, ANY cell the upload addresses can drop duties — a blank row removes just as a
      // Remove mark does — so the holder index is needed whenever an addressed cell already has a
      // committed roster. Decided cheaply from the files + committed roster, reading no volunteer;
      // building the index itself walks every shard of every region, so it only runs when it can matter.
      const touched = new Set();
      for (const f of files) {
        const a = clean(f.area);
        for (const e of (f.entries || [])) { const s = String(e.sessionId || ""); if (s && a) touched.add(s + "|" + a); }
      }
      const needsHolders = [...touched].some(k => {
        const i = k.indexOf("|"); return (((store.sessions[k.slice(0, i)] || {})[k.slice(i + 1)]) || []).length > 0;
      });
      const holderIdx = needsHolders ? await buildHolderIndex() : new Map();
      const plan = planRoster(files, catalog, sessions, {
        areas: AREAS, current: store.sessions,
        holders: (sid, area, duty) => holderIdx.get(String(sid) + "|" + clean(area) + "|" + norm(duty)) || [],
      });
      const report = {
        mode: commit ? "commit" : "preview",
        counts: plan.counts, summary: plan.summary, removed: plan.removed,
        blocked: plan.blocked, blockedCount: plan.blocked.length, untouched: plan.untouched.length,
        problems: plan.problems.slice(0, 500), problemCount: plan.problems.length,
        warnings: plan.warnings.slice(0, 500), warningCount: plan.warnings.length,
        newDuties: plan.newDuties, areasTouched: plan.areasTouched, gaps: plan.gaps,
        note: commit
          ? "Applied. The per-session duty rosters are saved and any new duties were added to the catalog."
          : "Preview only — nothing saved. Check the parsed check-in times and the new duties below before committing.",
      };

      // A blocked removal stops THAT ROW and nothing else. A file that removes two duties and adds two
      // more shouldn't be thrown away because one of the removals is held — the other three changes are
      // legitimate and the team still has to get them in. The held duty is simply left exactly as it
      // was, and reported loudly.
      const noteBits = [];
      if (plan.counts.cleared) {
        noteBits.push(plan.counts.cleared + " volunteer(s) " + (commit ? "were moved off" : "will be moved off")
          + " duties this upload drops \u2014 they\u2019re now unassigned in their area and flagged to reassign. "
          + "Place them on the Duty review or Assign duties screen, or re-run the duty allocation.");
      }
      if (plan.blocked.length) {
        const n = plan.blocked.length;
        noteBits.push(n + " duty removal" + (n === 1 ? " was" : "s were") + " NOT applied \u2014 "
          + (n === 1 ? "a volunteer is" : "volunteers are") + " already assigned in iVolunteer for "
          + (n === 1 ? "it" : "them") + ". Back that out in iVolunteer first; the app won't drop a duty "
          + "Better Impact is already holding. Everything else in "
          + (commit ? "this import was saved." : "the file is fine."));
      }
      if (noteBits.length) {
        report.note = (commit ? "Applied. " : "Preview only — nothing saved. ") + noteBits.join(" ");
      }

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

      // 2) the per-session roster. planRoster already merged each touched cell ONTO what was committed,
      //    so only session x area cells these files actually mention move at all, and within a cell only
      //    the rows that were filled in or marked Remove. Everything else is carried through untouched.
      const out = { sessions: JSON.parse(JSON.stringify(store.sessions || {})) };
      for (const sid of Object.keys(plan.roster)) {
        out.sessions[sid] = out.sessions[sid] || {};
        for (const area of Object.keys(plan.roster[sid])) {
          const cell = plan.roster[sid][area].map(r => ({ duty: r.duty, min: r.min, leads: r.leads,
            minAge: r.minAge || null, checkIn: r.checkIn }));
          // An area left with no rows has no roster for that session — carry no empty cell, or the
          // duty screens would read it as "rostered, zero duties" rather than "not rostered".
          if (cell.length) out.sessions[sid][area] = cell;
          else delete out.sessions[sid][area];
        }
        if (!Object.keys(out.sessions[sid]).length) delete out.sessions[sid];
      }
      out.updatedAt = new Date().toISOString();
      out.updatedBy = email;
      await writeJson(c, ROSTER_BLOB, out);
      report.roster = out.sessions;

      // 3) Clear anyone who was on a duty this import removed. Removed means gone: the duty is off the
      //    roster, so leaving them on it would strand them holding something that no longer exists —
      //    which is precisely what the old refusal existed to prevent. Pending puts them back within
      //    reach of the next allocation, which will place them on another duty they asked for, or in
      //    the pool. The roster is written FIRST: if this loop dies half way, the survivors are people
      //    holding a duty that is gone, which the review screen shows as off-roster and a re-run fixes.
      //    The reverse order would leave the roster claiming a duty nobody is on.
      let cleared = 0, clearSkipped = 0;
      const toClear = plan.removed.reduce((n, r) => n + (r.clearing || []).length, 0);
      // `c` above is the CONFIG container; the volunteers live in the data one. Only opened if there
      // is actually somebody to move.
      const dataC = toClear ? await getContainer(DATA_CONTAINER) : null;
      for (const rem of plan.removed) {
        for (const h of (rem.clearing || [])) {
          if (!h.region) { clearSkipped++; continue; }
          const res = await mutateVolunteer(dataC, h.region, h.user_id, (v) => {
            const row = sessionRow(v, rem.session);
            // They may have been moved between the preview and this commit. Only clear the duty this
            // import actually removed — never whatever they hold now.
            if (!row || norm(row.duty) !== norm(h.duty)) return { skip: true };
            if (LOCKED_STATES.includes(clean(row.state))) return { skip: true };
            row.duty = ""; row.state = "pending";
            // Flag them for reassignment so the area sees, on Duty review and Assign duties, exactly who
            // lost a duty and needs placing again — not just a log line. Cleared on the next assignment.
            row.needs_reassign = true;
            row.reassign_from = h.duty;
            v.activity_log = v.activity_log || [];
            v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "duty_cleared",
              reason: "duty_removed_from_roster", session: rem.session, area: rem.area, duty: h.duty });
          });
          if (res.ok && !(res.extra || {}).skip) cleared++; else clearSkipped++;
        }
      }
      report.cleared = cleared;
      report.clearSkipped = clearSkipped;
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
