// Duty confirmation emails.
//
// STAGE 1 (this file): a READ-ONLY dry run. GET with no session lists the sessions; GET with a session
// returns who WOULD be emailed for it (on the iVol lineup or entered, with an email, not yet notified),
// who is on the lineup but has no address (phone them), how many were already emailed, and a rendered
// SAMPLE of the exact message. It writes nothing and sends nothing — it exists to confirm the selection
// and the wording against real data before the send path is wired.
//
// Selection + rendering live in shared/dutyemail (pure, unit-tested). Visible to Super Admin and Admin
// (region-walled). Sending, the notified_at stamp, and the toggle-off reset come in the next step.
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor, readSessions, readConfigJson } = require("../shared/store");
const { buildLookups, selectForSession, renderDutyEmail } = require("../shared/dutyemail");

const ROSTER_BLOB = "session-duties.json";
const DUTIES_BLOB = "duties.json";
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const SAMPLE_CAP = 500;   // how many eligible rows to return for the preview list (counts are exact)

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const emailOf = (p) => {
  if (!p) return null;
  let e = p.userDetails || null;
  if (!e && Array.isArray(p.claims)) {
    const c = p.claims.find(c => /(emailaddress|email|preferred_username|upn)$/i.test(c.typ || c.type || ""));
    if (c) e = c.val || c.value;
  }
  return e ? String(e).toLowerCase() : null;
};

module.exports = async function (context, req) {
  try {
    const p = getPrincipal(req);
    const roles = (p && p.userRoles) || [];
    const email = emailOf(p);
    const isSuper = roles.includes("superadmin");
    const isAdmin = roles.includes("admin");
    if (!(isSuper || isAdmin)) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const sessions = await readSessions(null);

    // No session chosen yet -> hand the picker the list.
    const want = String((req.query && req.query.session) || "").trim();
    if (!want) { context.res = { body: { sessions: sessions.map(s => ({ id: String(s.id), name: s.name })) } }; return; }

    const session = sessions.find(s => String(s.id) === want);
    if (!session) { context.res = { status: 404, body: { error: "Unknown session." } }; return; }

    // Region scope: superadmin sees all; admin is walled to their event regions.
    let regions = REGIONS.slice();
    if (!isSuper) {
      const allowed = allowedRegionsFor(await readRolesStore(), email) || [];
      regions = regions.filter(r => allowed.includes(r));
    }

    const container = await getContainer(DATA_CONTAINER);
    const rosterStore = await readConfigJson(ROSTER_BLOB);
    const catalog = await readConfigJson(DUTIES_BLOB);
    const lookups = buildLookups(sessions, rosterStore, catalog);

    const counts = { eligible: 0, noEmail: 0, alreadySent: 0, onLineup: 0 };
    const eligible = [], noEmail = [];
    let firstFull = null;   // first fully-enriched eligible recipient, for the rendered sample
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      const sel = selectForSession(records, want, lookups);
      counts.eligible += sel.eligible.length;
      counts.noEmail += sel.noEmail.length;
      counts.alreadySent += sel.alreadySent;
      counts.onLineup += sel.onLineup;
      if (!firstFull && sel.eligible[0]) firstFull = sel.eligible[0];
      for (const e of sel.eligible) if (eligible.length < SAMPLE_CAP)
        eligible.push({ user_id: e.user_id, name: e.name, region: e.region, area: e.area, dutyName: e.dutyName, checkIn: e.checkIn, isLead: e.isLead, email: e.email });
      for (const e of sel.noEmail)
        noEmail.push({ user_id: e.user_id, name: e.name, region: e.region, area: e.area, dutyName: e.dutyName });
    }

    // A sample rendered from a real eligible recipient when there is one, else a synthetic row so the
    // wording is always visible.
    const sample = renderDutyEmail(firstFull || {
      name: "Volunteer", sessionName: session.name, dutyName: "(duty)",
      description: "(duty description)", checkIn: "(check-in time)",
    });

    context.res = { body: {
      session: { id: String(session.id), name: session.name },
      counts, capped: counts.eligible > eligible.length, eligible, noEmail, sample,
    } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
