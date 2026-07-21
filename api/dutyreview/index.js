// Duty review (Phase 4b): an area looks at the lineup the allocation gave it, moves people between
// duties, picks its leads, and submits it for iVolunteer entry.
//
// WHO — Duty Allocation Leads (dutyteam), Admins, Super Admins, and the area's own quarterbacks.
//
// SEEING vs CHANGING are scoped differently, on purpose. The July 24 Afternoon session draws from
// Prairies AND Edmonton, but a duty's minimum is a floor for the WHOLE lineup, not per region. A
// quarterback scoped area x region who could only see their own half would be unable to tell whether
// the floor of 12 is met, and two half-blind quarterbacks would each pick two leads and produce four.
// So: the lineup and its counts are visible to anyone who holds the AREA (any region), while
// reassigning a person is gated on that person's own region. Nobody is ever half-blind, and nobody
// changes anyone outside their grant.
//
// STATE — pending -> allocated (engine) -> submitted (this screen) -> entered (iVol). "entered" is
// the wall: once iVolunteer holds the duty it is frozen, per session row, not per lineup. Everything
// short of that stays editable, so an area can keep revising while iVol works through the queue.
const { getContainer, readRegion, mutateVolunteer, REGIONS, readDidars, readSessions,
        readRolesStore, allowedRegionsFor, scopesFor, areasFor, inScope, readConfigJson } = require("../shared/store");
const { expandRoster, sessionRow, requestsOf, isLeadName,
        STATE_ALLOCATED, STATE_SUBMITTED, STATE_ENTERED, LOCKED_STATES } = require("../dutyalloc/dutyalloc");
const { AS_OF, ageOfOn } = require("../shared/eventage");
const { notAssignable } = require("../shared/rollup");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const clean = (s) => String(s == null ? "" : s).trim();
const norm = (s) => clean(s).toLowerCase();
const nameOf = (v) => ((v.first || "") + " " + (v.last || "")).trim() || "(no name)";

// The five registration lists, as the rest of the app defines them: two stored flags, two age bands,
// and General for anyone in none of them. Someone can be in more than one (an IFF senior), so this
// returns a list rather than picking a winner.
//
// Derived here rather than in the browser because matchesGroup() is already copy-pasted into four
// screens (app, quarterback, accepted, all-volunteers) and a fifth copy is a fifth thing to drift.
// The age used is the EVENT-DAY age — the same number this screen shows — so the Group column and the
// Age column beside it can never contradict each other.
function groupsOf(v, age) {
  const g = [];
  if (v.iff) g.push("IFF");
  if (v.diverse) g.push("Diverse Abilities");
  if (age != null && age > 65) g.push("Seniors");
  if (age != null && age >= 5 && age <= 13) g.push("Young");
  return g;
}

module.exports = async function (context, req) {
  try {
    const hdr = req.headers["x-ms-client-principal"];
    if (!hdr) { context.res = { status: 401, body: { error: "Not signed in." } }; return; }
    const p = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    const email = String(p.userDetails || "").toLowerCase();
    const roles = p.userRoles || [];

    const isSuper = roles.includes("superadmin");
    const isLead = roles.includes("admin") || roles.includes("dutyteam");   // Duty Allocation Leads
    const isQb = roles.includes("quarterback");
    if (!isSuper && !isLead && !isQb) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }

    const store = await readRolesStore();
    const qbScopes = isQb ? scopesFor(store, email, "quarterback") : [];
    const qbAreas = areasFor(qbScopes);
    // Which regions may this person CHANGE people in? Super: all. Lead: their granted regions.
    // Quarterback: the regions they hold the area in — resolved per area, below.
    const leadRegions = isSuper ? null : (isLead ? (allowedRegionsFor(store, email) || []) : []);

    const canSeeArea = (area) => isSuper || isLead || qbAreas.includes(area);
    const canEditPerson = (area, region) => {
      if (isSuper) return true;
      if (isLead && (leadRegions === null || leadRegions.includes(region))) return true;
      return isQb && inScope(qbScopes, area, region);   // the quarterback's own cell, exactly
    };

    const sessions = await readSessions(null);
    const didars = await readDidars();
    const regionsOfSession = (s) => {
      const d = didars.find(x => String(x.id) === String(s.parent));
      return d ? REGIONS.filter(R => (d.regions || []).includes(R)) : REGIONS;
    };
    const rosterStore = (await readConfigJson("session-duties.json")) || {};
    const rosterFor = (sid) => (rosterStore.sessions || {})[String(sid)] || {};

    // ---- GET: the areas this person can review, or one session x area lineup -------------------
    if (req.method !== "POST") {
      const sid = clean(req.query.session);
      const area = clean(req.query.area);

      if (!sid || !area) {
        // The picker: every session, and the areas in it this person may review.
        const out = sessions.map(s => {
          const rostered = Object.keys(rosterFor(s.id)).sort();
          return { id: s.id, name: s.name, regions: regionsOfSession(s),
            areas: rostered.filter(canSeeArea) };
        });
        context.res = { headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessions: out, asOf: AS_OF,
            role: isSuper ? "superadmin" : isLead ? "dutyteam" : "quarterback" }) };
        return;
      }

      const session = sessions.find(x => String(x.id) === sid);
      if (!session) { context.res = { status: 400, body: { error: "Unknown session." } }; return; }
      if (!canSeeArea(area)) { context.res = { status: 403, body: { error: "That area isn't one of yours." } }; return; }

      const scope = regionsOfSession(session);
      const specs = expandRoster(rosterFor(sid)[area] || []);
      if (!specs.length) {
        context.res = { headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: `No duty roster has been imported for ${area} in \u201c${session.name}\u201d yet.` }) };
        return;
      }

      const container = await getContainer(DATA_CONTAINER);
      const people = [];
      const tally = {};
      for (const spec of specs) tally[spec.duty] = 0;
      for (const R of scope) {
        const { records } = await readRegion(container, R);
        for (const v of records) {
          const row = sessionRow(v, sid);
          if (!row || clean(row.area) !== area) continue;
          const duty = clean(row.duty);
          if (duty) tally[duty] = (tally[duty] || 0) + 1;
          const age = ageOfOn(v, AS_OF);
          people.push({
            user_id: v.user_id, name: nameOf(v), region: v.region, jk: clean(v.ceremony_jk),
            groups: groupsOf(v, age),
            // EVENT-DAY age: the same number every age rule in the app is measured against, so a
            // reviewer never sees "18" beside a 19+ duty the person legitimately holds.
            age,
            duty, state: clean(row.state) || "pending",
            locked: LOCKED_STATES.includes(clean(row.state)),
            no_bi_account: !!v.no_bi_account,     // gates the add-to-lineup toggle in the UI
            leader: !!v.leader_flag,              // Team Lead from the roster upload — surfaced as a badge
            canEdit: canEditPerson(area, v.region),
            wants: requestsOf(v).filter(x => specs.some(s => norm(s.duty) === norm(x))),
            assigned: clean(v.assigned_duty) || null,
          });
        }
      }
      people.sort((a, b) => (a.duty || "\uffff").localeCompare(b.duty || "\uffff") || a.name.localeCompare(b.name));

      const duties = specs.map(s => ({
        duty: s.duty, min: s.min, minAge: s.minAge, checkIn: s.checkIn, isLead: s.isLead, leadOf: s.leadOf,
        assigned: tally[s.duty] || 0, shortfall: Math.max(0, s.min - (tally[s.duty] || 0)),
      }));
      // A duty someone holds that the roster no longer lists — the roster's Remove guard makes this
      // hard to reach, but a hand-edited blob or an older commit could.
      const offRoster = Object.keys(tally).filter(d => !specs.some(s => norm(s.duty) === norm(d)))
        .map(d => ({ duty: d, assigned: tally[d] }));

      const editable = people.filter(x => x.canEdit && !x.locked).length;
      context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        session: sid, sessionName: session.name, area, regions: scope, asOf: AS_OF,
        duties, offRoster, people,
        counts: {
          members: people.length, editable,
          pending: people.filter(x => !x.duty).length,
          allocated: people.filter(x => x.state === STATE_ALLOCATED && x.duty).length,
          submitted: people.filter(x => x.state === STATE_SUBMITTED).length,
          entered: people.filter(x => x.state === STATE_ENTERED).length,
          shortfallTotal: duties.reduce((n, d) => n + d.shortfall, 0),
          leadsRequired: duties.filter(d => d.isLead).reduce((n, d) => n + d.min, 0),
          leadsChosen: duties.filter(d => d.isLead).reduce((n, d) => n + d.assigned, 0),
        },
        // Whole-lineup visibility, partial edit rights: say so plainly rather than letting someone
        // wonder why a row won't change.
        partial: people.length > 0 && editable < people.filter(x => !x.locked).length,
        canSubmit: true,
      }) };
      return;
    }

    // ---- POST: reassign one person, or submit the lineup ---------------------------------------
    const body = req.body || {};
    const op = clean(body.op);
    const sid = clean(body.session);
    const area = clean(body.area);
    const session = sessions.find(x => String(x.id) === sid);
    if (!session) { context.res = { status: 400, body: { error: "Unknown session." } }; return; }
    if (!canSeeArea(area)) { context.res = { status: 403, body: { error: "That area isn't one of yours." } }; return; }
    const scope = regionsOfSession(session);
    const specs = expandRoster(rosterFor(sid)[area] || []);
    if (!specs.length) { context.res = { status: 400, body: { error: "No duty roster for that area." } }; return; }
    const container = await getContainer(DATA_CONTAINER);

    if (op === "reassign") {
      const region = clean(body.region);
      const duty = clean(body.duty);
      if (!scope.includes(region)) { context.res = { status: 400, body: { error: "That region isn't in this session." } }; return; }
      if (!canEditPerson(area, region)) {
        context.res = { status: 403, body: { error: `You can see this whole lineup, but you can only change ${region === "Edmonton" ? "Edmonton" : region} volunteers if that region is one of yours.` } };
        return;
      }
      const spec = duty ? specs.find(s => norm(s.duty) === norm(duty)) : null;
      if (duty && !spec) { context.res = { status: 400, body: { error: "That duty isn't on this roster." } }; return; }

      let out = null;
      const result = await mutateVolunteer(container, region, body.user_id, (v) => {
        const row = sessionRow(v, sid);
        if (!row) return { notInSession: true };
        if (clean(row.area) !== area) return { wrongArea: true };
        if (LOCKED_STATES.includes(clean(row.state))) return { locked: true };
        const from = clean(row.duty) || null;
        const age = ageOfOn(v, AS_OF);
        // The age rule is a WARNING here, not a wall: a person reviewing a lineup may know something
        // the date of birth on file doesn't. It is logged either way, so the decision has an owner.
        const tooYoung = !!(spec && spec.minAge && (age == null || age < spec.minAge));
        row.duty = spec ? spec.duty : "";
        // A row already submitted STAYS submitted — dropping it back to "allocated" would silently
        // pull it out of iVol's queue, and the change would land nowhere.
        if (!spec) row.state = "pending";
        else if (clean(row.state) !== STATE_SUBMITTED) row.state = STATE_ALLOCATED;
        v.activity_log = v.activity_log || [];
        v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "duty_reassign",
          session: sid, area, from, to: row.duty || null, state: row.state,
          ...(tooYoung ? { override: "under_minimum_age", age, minAge: spec.minAge } : {}) });
        out = { from, to: row.duty || null, state: row.state, tooYoung, age, minAge: spec ? spec.minAge : null };
      });

      if (result.notFound) { context.res = { status: 404, body: { error: "Volunteer not found." } }; return; }
      const x = result.extra || {};
      if (x.notInSession) { context.res = { status: 409, body: { error: "They're not in this session — reload." } }; return; }
      if (x.wrongArea) { context.res = { status: 409, body: { error: "They're not in this area any more — reload." } }; return; }
      if (x.locked) { context.res = { status: 409, body: { error: "That duty is already entered in iVolunteer and is locked. It has to be backed out there first." } }; return; }
      if (!result.ok) { context.res = { status: 409, body: { error: "Couldn't save — please retry." } }; return; }

      context.res = { body: { ok: true, ...out,
        note: out.tooYoung
          ? `Saved \u2014 but they're ${out.age == null ? "of unknown age" : out.age} and ${out.to} is ${out.minAge}+. Recorded against your name.`
          : null } };
      return;
    }

    if (op === "assign_bulk") {
      // Mass duty assignment, in one pass: give many people ONE duty AND add them to the lineup — the same
      // as doing a reassign then the add-to-lineup toggle for each, applied via mutateVolunteer (one shard
      // each, ETag + retries — peak-safe). Untouched: submitted (already on the lineup) and entered (locked).
      // Blocked/inactive are skipped entirely; no-BI people get the duty but are HELD OFF the lineup until
      // they have a Better Impact account — exactly the gates the per-person toggle and "add all" enforce.
      // The age minimum is a warning, logged, never a wall.
      const duty = clean(body.duty);
      const items = Array.isArray(body.items) ? body.items : [];
      const spec = specs.find(s => norm(s.duty) === norm(duty));
      if (!spec) { context.res = { status: 400, body: { error: "Pick a duty that's on this roster." } }; return; }
      if (!items.length) { context.res = { status: 400, body: { error: "No volunteers selected." } }; return; }

      const seen = new Set(); const work = [];
      const skipped = { locked: 0, onLineup: 0, notInSession: 0, wrongArea: 0, outOfScope: 0, blocked: 0 };
      for (const it of items) {
        const uid = clean(it && it.user_id), region = clean(it && it.region);
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        if (!scope.includes(region) || !canEditPerson(area, region)) { skipped.outOfScope++; continue; }
        work.push({ user_id: uid, region });
      }

      const nowIso = new Date().toISOString();
      let added = 0, needsBi = 0, tooYoung = 0, failed = 0;
      const needsBiNames = [], tooYoungNames = [];
      let idx = 0;
      const run = async () => {
        while (idx < work.length) {
          const job = work[idx++];
          try {
            const res = await mutateVolunteer(container, job.region, job.user_id, (v) => {
              const row = sessionRow(v, sid);
              if (!row) return { skip: "notInSession" };
              if (clean(row.area) !== area) return { skip: "wrongArea" };
              const st = clean(row.state);
              if (LOCKED_STATES.includes(st)) return { skip: "locked" };       // entered — frozen in iVol
              if (st === STATE_SUBMITTED) return { skip: "onLineup" };          // already on the lineup — leave it
              if (notAssignable(v)) return { skip: "blocked" };                 // blocked / inactive — never on a lineup
              const from = clean(row.duty) || null;
              const age = ageOfOn(v, AS_OF);
              const young = !!(spec.minAge && (age == null || age < spec.minAge));
              row.duty = spec.duty;
              // Assign AND add to the lineup — unless there's no Better Impact account yet, in which case
              // they hold the duty (allocated) and wait, the same gate the per-person toggle enforces.
              const onLineup = !v.no_bi_account;
              row.state = onLineup ? STATE_SUBMITTED : STATE_ALLOCATED;
              v.activity_log = v.activity_log || [];
              v.activity_log.push({ ts: nowIso, actor: email, action: "duty_reassign", session: sid, area,
                from, to: spec.duty, state: row.state, via: "mass_assign",
                ...(young ? { override: "under_minimum_age", age, minAge: spec.minAge } : {}) });
              if (onLineup) v.activity_log.push({ ts: nowIso, actor: email, action: "duty_submit", session: sid, area, duty: spec.duty, via: "mass_assign" });
              return { added: onLineup, needsBi: !onLineup, young, name: nameOf(v) };
            });
            const x = (res && res.extra) || {};
            if (res && res.ok && (x.added || x.needsBi)) {
              if (x.added) added++; else { needsBi++; if (needsBiNames.length < 25) needsBiNames.push(x.name); }
              if (x.young) { tooYoung++; if (tooYoungNames.length < 25) tooYoungNames.push(x.name); }
            } else if (res && res.ok && x.skip) { skipped[x.skip] = (skipped[x.skip] || 0) + 1; }
            else failed++;
          } catch (e) { failed++; }
        }
      };
      const CONC = Math.min(6, work.length || 1);
      await Promise.all(Array.from({ length: CONC }, run));

      context.res = { body: { ok: true, duty: spec.duty, minAge: spec.minAge || null,
        added, needsBi, needsBiNames, skipped, failed, tooYoung, tooYoungNames } };
      return;
    }

    if (op === "set_lineup") {
      // on=true  -> put this ONE person on the lineup   (allocated -> submitted)
      // on=false -> take them back off it                (submitted -> allocated)
      // Off is allowed because On iVol Lineup is not locked; Assigned in iVol (entered) is, and stays so.
      const region = clean(body.region);
      const on = body.on !== false;                 // default to putting them on
      if (!scope.includes(region)) { context.res = { status: 400, body: { error: "That region isn't in this session." } }; return; }
      if (!canEditPerson(area, region)) {
        context.res = { status: 403, body: { error: `You can only change ${region} volunteers if that region is one of yours.` } };
        return;
      }
      let out = null;
      const result = await mutateVolunteer(container, region, body.user_id, (v) => {
        const row = sessionRow(v, sid);
        if (!row) return { notInSession: true };
        if (clean(row.area) !== area) return { wrongArea: true };
        // Both gates apply only when ADDING to the lineup; taking someone off always works.
        if (on && notAssignable(v)) return { notAssignable: true };              // blocked / inactive
        if (on && v.no_bi_account) return { needsBi: true };                     // no Better Impact account yet
        if (LOCKED_STATES.includes(clean(row.state))) return { locked: true };   // entered — cannot toggle
        if (on && !clean(row.duty)) return { noDuty: true };                      // nothing to commit yet
        row.state = on ? STATE_SUBMITTED : STATE_ALLOCATED;
        if (!on) delete row.notified_at;   // off the lineup -> clear the email stamp so a re-add is emailable again
        v.activity_log = v.activity_log || [];
        v.activity_log.push({ ts: new Date().toISOString(), actor: email,
          action: on ? "duty_submit" : "duty_unsubmit", session: sid, area, duty: clean(row.duty) });
        out = { state: row.state, on };
      });
      if (result.notFound) { context.res = { status: 404, body: { error: "Volunteer not found." } }; return; }
      const x = result.extra || {};
      if (x.notInSession) { context.res = { status: 409, body: { error: "They're not in this session \u2014 reload." } }; return; }
      if (x.wrongArea) { context.res = { status: 409, body: { error: "They're not in this area any more \u2014 reload." } }; return; }
      if (x.notAssignable) { context.res = { status: 409, body: { error: "This volunteer is inactive or blocked and can't be added to a lineup." } }; return; }
      if (x.needsBi) { context.res = { status: 409, body: { error: "This volunteer needs a Better Impact account before they can be added to a lineup. Once the account is created, you can add them." } }; return; }
      if (x.locked) { context.res = { status: 409, body: { error: "They're already Assigned in iVol and locked \u2014 back it out in Better Impact first." } }; return; }
      if (x.noDuty) { context.res = { status: 409, body: { error: "Give them a duty before adding them to the lineup." } }; return; }
      if (!result.ok) { context.res = { status: 409, body: { error: "Couldn't save \u2014 please retry." } }; return; }
      context.res = { body: { ok: true, ...out } };
      return;
    }

    if (op === "submit") {
      // Submit the ALLOCATED rows and say who was left behind. Blocking on stragglers would mean a
      // late accepter with no duty holds up an entire area's lineup; iVol can start on the rest.
      let submitted = 0, pending = 0, already = 0, locked = 0, skipped = 0, noBi = 0;
      const names = [];
      const noBiNames = [];
      for (const R of scope) {
        const { records } = await readRegion(container, R);
        const ids = [];
        for (const v of records) {
          const row = sessionRow(v, sid);
          if (!row || clean(row.area) !== area) continue;
          if (notAssignable(v)) continue;                                        // blocked / inactive: never on a lineup
          if (v.no_bi_account) { noBi++; if (noBiNames.length < 25) noBiNames.push(nameOf(v)); continue; }   // needs a BI account first
          if (!clean(row.duty)) { pending++; if (names.length < 25) names.push(nameOf(v)); continue; }
          const st = clean(row.state);
          if (st === STATE_ENTERED) { locked++; continue; }
          if (st === STATE_SUBMITTED) { already++; continue; }
          if (!canEditPerson(area, v.region)) { skipped++; continue; }
          ids.push(v.user_id);
        }
        for (const id of ids) {
          const r = await mutateVolunteer(container, R, id, (v) => {
            const row = sessionRow(v, sid);
            if (!row || LOCKED_STATES.includes(clean(row.state))) return { skip: true };
            row.state = STATE_SUBMITTED;
            v.activity_log = v.activity_log || [];
            v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "duty_submit",
              session: sid, area, duty: clean(row.duty) });
          });
          if (r.ok && !(r.extra || {}).skip) submitted++;
        }
      }
      const bits = [`${submitted} volunteer(s) submitted for iVolunteer entry.`];
      if (already) bits.push(`${already} were already submitted.`);
      if (locked) bits.push(`${locked} are already entered and locked.`);
      if (noBi) bits.push(`${noBi} need a Better Impact account and were NOT submitted \u2014 create the account, then add them.`);
      if (pending) bits.push(`${pending} have no duty yet and were NOT submitted \u2014 re-run the duty allocation to place them, then submit again.`);
      if (skipped) bits.push(`${skipped} are outside the regions you can change and were left for someone else.`);
      context.res = { body: { ok: true, submitted, already, locked, pending, skipped, noBi,
        pendingNames: names, noBiNames, note: bits.join(" ") } };
      return;
    }

    context.res = { status: 400, body: { error: "Unknown action." } };
  } catch (e) {
    context.log.error("dutyreview failed", e);
    context.res = { status: 500, body: { error: "Something went wrong." } };
  }
};
