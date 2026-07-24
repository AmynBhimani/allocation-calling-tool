// Event-day roster (read-only): every volunteer placed into a session, with the session they are on,
// their area, and the duty they hold. One row per person PER SESSION — someone working both Didar
// sessions appears twice, which is what a process area needs on the day.
//
// WHO — Super Admins, Admins and Duty Allocation Leads see every area; a quarterback sees the areas
// they hold. Seeing is by AREA across regions, the same rule the duty review screen uses: an area
// that draws from two regions must see its whole roster or it can't run the day.
//
// EVER READY TEAM — a placed volunteer with no specific duty is not "blank", they are the floating
// reserve. They are reported under the area name "Ever Ready Team", carrying their home area so an
// area lead can still tell where they came from. Scope is always applied to the HOME area, so a
// quarterback keeps sight of their own people once those people join the reserve.
//
// Only people who are still ACCEPTED appear. Someone who withdrew after being placed can keep a
// session row (the roster sync preserves rows that already carry a duty), and putting them on an
// event-day list would send an area looking for a person who isn't coming.
const { getContainer, readRegion, REGIONS, readDidars, readSessions,
        readRolesStore, scopesFor, areasFor, readConfigJson } = require("../shared/store");
const { isAcceptedVolunteer } = require("../shared/rollup");
const { expandRoster } = require("../dutyalloc/dutyalloc");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const ROSTER_BLOB = "session-duties.json";
const clean = (s) => String(s == null ? "" : s).trim();
const normDuty = (s) => clean(s).toLowerCase().replace(/\s+/g, " ");
const EVER_READY = "Ever Ready Team";
// A write-in has no Better Impact account, so no id that means anything to BI.
const isWritein = (v) => !!(v && (v.no_bi_account || String(v.user_id).startsWith("wi-")));

module.exports = async function (context, req) {
  try {
    const hdr = req.headers["x-ms-client-principal"];
    if (!hdr) { context.res = { status: 401, body: { error: "Not signed in." } }; return; }
    const p = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    const email = String(p.userDetails || "").toLowerCase();
    const roles = p.userRoles || [];

    const isSuper = roles.includes("superadmin");
    const isLead = roles.includes("admin") || roles.includes("dutyteam");
    const isQb = roles.includes("quarterback");
    if (!isSuper && !isLead && !isQb) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }

    const store = await readRolesStore();
    const qbAreas = isQb ? areasFor(scopesFor(store, email, "quarterback")) : [];
    const canSeeArea = (area) => isSuper || isLead || qbAreas.includes(area);

    // Session id -> its name and its Didar's name. Sessions live under Didars; a session row's
    // event id is the SESSION id (basis "session"), which is what carries a usable name.
    const didars = await readDidars();
    const sessionsById = {};
    for (const d of didars) {
      for (const s of await readSessions(d.id)) {
        sessionsById[String(s.id)] = { name: clean(s.name) || String(s.id), didar: clean(d.name) };
      }
    }

    const container = await getContainer(DATA_CONTAINER);

    // Check-in times live on the duty roster, not on the volunteer. Index (session, area, duty) -> time
    // using the engine's own expander, so generated LEAD duties carry their real (earlier) check-in
    // rather than the one their parent duty has.
    const rosterStore = (await readConfigJson(ROSTER_BLOB)) || {};
    const checkInIdx = new Map();
    for (const sid of Object.keys(rosterStore.sessions || {})) {
      const byArea = rosterStore.sessions[sid] || {};
      for (const a of Object.keys(byArea)) {
        for (const spec of expandRoster(byArea[a] || [])) {
          checkInIdx.set(String(sid) + "|" + a + "|" + normDuty(spec.duty), clean(spec.checkIn));
        }
      }
    }
    const checkInFor = (sid, area, duty) =>
      duty ? (checkInIdx.get(String(sid) + "|" + area + "|" + normDuty(duty)) || "") : "";

    const rows = [];
    for (const region of REGIONS) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        if (!isAcceptedVolunteer(v)) continue;                    // not coming — keep them off the day's roster
        const assignments = Array.isArray(v.event_assignments) ? v.event_assignments : [];
        for (const r of assignments) {
          if (!r || r.basis !== "session") continue;              // didar-level seed rows aren't a session placement
          const session = sessionsById[String(r.event)];
          if (!session) continue;                                 // retired or unknown session
          const homeArea = clean(r.area);
          if (!homeArea || !canSeeArea(homeArea)) continue;       // scope on the HOME area, always
          const duty = clean(r.duty);
          rows.push({
            first: clean(v.first), last: clean(v.last),
            visitId: String(v.user_id == null ? "" : v.user_id),   // the Better Impact account id
            noBi: isWritein(v),                                    // write-in: that id means nothing to BI
            session: session.name, sessionId: String(r.event), didar: session.didar,
            area: duty ? homeArea : EVER_READY,                   // no duty -> the floating reserve
            homeArea, duty, everReady: !duty,
            checkIn: checkInFor(r.event, homeArea, duty),          // "" when they hold no duty
            region, state: clean(r.state) || "pending",
          });
        }
      }
    }

    rows.sort((a, b) =>
      a.session.localeCompare(b.session) || a.area.localeCompare(b.area) ||
      (a.duty || "\uffff").localeCompare(b.duty || "\uffff") ||
      (a.last || "").localeCompare(b.last || "") || (a.first || "").localeCompare(b.first || ""));

    // Filter vocabularies, built from what this person can actually see.
    const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    context.res = { body: {
      rows, count: rows.length,
      sessions: uniq(rows.map(r => r.session)),
      areas: uniq(rows.map(r => r.area)),
      duties: uniq(rows.map(r => r.duty)),
      everReadyCount: rows.filter(r => r.everReady).length,
    } };
  } catch (err) {
    context.log && context.log.error && context.log.error("eventday failed:", (err && err.stack) || err);
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
