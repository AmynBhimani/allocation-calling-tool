// Duty allocation (Phase 4a) — pure function over stored records. No I/O.
// Deterministic given the same records + seed, so preview and commit always match.
//
// Runs per SESSION. For each area in that session it reads the imported roster (minimum + leads per
// duty, Phase 3) and gives every session member exactly one duty:
//
//   Pass 0 — ASSIGNED duties, UNCAPPED. A caller wrote assigned_duty on this person: that is a
//            promise made to a volunteer, so it outranks the floors. It can starve another duty
//            below its minimum; that shows up in the shortfall report rather than being prevented.
//   Pass 1 — a SINGLE expressed interest, capped at the minimum. One pick is a strong signal, so
//            they choose before the multi-interest crowd — but a preference is not a promise, so the
//            cap still applies.
//   Pass 2 — multi-interest, CAPPED AT THE MINIMUM. Each person gets the first duty on their list
//            that is still under its floor. The cap is the whole point: without it everyone piles
//            into the popular duty and the unpopular one starves below its minimum.
//   Pass 3 — fill the remaining floors from whoever is left, at random.
//   Pass 4 — surplus. Their requested duty if they had one (the floor is a floor, not a cap), else
//            spread by lowest fill ratio, which lands people proportionally to the minimums.
//
// AGE: a duty may set a stricter minimum age than its area. The reference is the EVENT DAY
// (ageAsOf + AS_OF), never today — the area gate already works that way, and using today's age here
// would let the app place someone in a 19+ area and refuse them a 19+ duty in it on the same day.
// Nobody is ever placed into a duty they are too young for: the floor goes short and says so.
//
// LEADS are a derived duty. "Server, leads 2" yields a separate "Lead - Server" with min 2 — an
// ADDITIONAL 2 people, not 2 of the 12. This engine deliberately leaves lead duties EMPTY: choosing
// leads is a judgement call the area makes on the review screen.
//
// RE-RUN SAFETY: this fills GAPS ONLY. A row that already carries a duty — allocated, submitted or
// entered — is never touched, and its person still counts toward that duty's total. Volunteers keep
// accepting daily, so this gets re-run constantly; if a re-run reshuffled people it would silently
// destroy every area's review work. Leads are deliberately NOT chosen here: that is a judgement call
// the area team makes on the review screen.

const STATE_PENDING = "pending";
const STATE_ALLOCATED = "allocated";
const STATE_SUBMITTED = "submitted";
const STATE_ENTERED = "entered";
// Once iVolunteer holds the duty it is frozen — the trigger is per volunteer, not per lineup.
const LOCKED_STATES = [STATE_ENTERED];

const clean = (s) => String(s == null ? "" : s).trim();
const norm = (s) => clean(s).toLowerCase();

// The reserved prefix. Lead duties are DERIVED from a roster row's `leads` count, never typed, so a
// real duty may not use it — the roster import refuses the name.
const LEAD_PREFIX = "Lead - ";
const LEAD_RE = /^lead\s*-\s*/i;
const isLeadName = (n) => LEAD_RE.test(clean(n));
const leadNameFor = (duty) => LEAD_PREFIX + clean(duty);

// Leads come in an hour before their crew. Clamped at 00:00 rather than wrapping to the previous
// day: the roster has no date (the session title carries it), so 23:30 would be unreadable.
function leadCheckIn(checkIn) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clean(checkIn));
  if (!m) return clean(checkIn);
  const mins = Number(m[1]) * 60 + Number(m[2]);
  const back = mins - 60;
  if (back <= 0) return "00:00";
  return String(Math.floor(back / 60)).padStart(2, "0") + ":" + String(back % 60).padStart(2, "0");
}

// Age on the EVENT DAY — the same definition the area allocation gates on, imported rather than
// copied so the two can never drift. See api/shared/eventage.js for why that matters.
const { AS_OF, ageAsOf, ageOfOn } = require("../shared/eventage");

// One roster row -> the duty itself, plus its lead duty if it needs leads. The lead duty inherits
// the minimum age (a lead is still doing the job) and checks in an hour earlier.
function expandRoster(duties) {
  const out = [];
  for (const d of (duties || [])) {
    const duty = clean(d.duty); if (!duty) continue;
    const minAge = Number(d.minAge) > 0 ? Number(d.minAge) : null;
    out.push({ duty, min: Number(d.min) || 0, minAge, checkIn: clean(d.checkIn), isLead: false, leadOf: null });
    const leads = Number(d.leads) || 0;
    if (leads > 0) out.push({ duty: leadNameFor(duty), min: leads, minAge,
      checkIn: leadCheckIn(d.checkIn), isLead: true, leadOf: duty });
  }
  return out;
}

// Same seeded RNG as the area allocation, so behaviour is familiar and reproducible.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const sessionRow = (v, sessionId) => (Array.isArray(v.event_assignments) ? v.event_assignments : [])
  .find(r => r && String(r.event) === String(sessionId) && r.basis === "session") || null;

// A volunteer's region fixes their Didar and their Jamatkhana fixes their session, so a volunteer has
// AT MOST ONE session row. Where that invariant is the point — a screen with no session picker — this
// finds the row without needing to know the id first. Note sessionRow(v, null) does NOT do this: it
// would compare against the string "null" and match nothing.
const theSessionRow = (v) => (Array.isArray(v.event_assignments) ? v.event_assignments : [])
  .find(r => r && r.basis === "session") || null;

// Duties this person expressed interest in, across every event, deduped and order preserved.
const requestsOf = (v) => [...new Set((Array.isArray(v.event_assignments) ? v.event_assignments : [])
  .flatMap(a => (Array.isArray(a && a.candidate_duties) ? a.candidate_duties : []))
  .map(d => clean(d)).filter(Boolean))];

const nameOf = (v) => ((v.first || "") + " " + (v.last || "")).trim() || "(no name)";

// records: volunteers across the session's regions. roster: {area: [{duty,min,leads,checkIn}]}.
function planDuties(records, roster, cfg) {
  cfg = cfg || {};
  const sessionId = String(cfg.sessionId || "");
  const rng = mulberry32((cfg.seed != null ? cfg.seed : 1234567) >>> 0);
  const asOf = cfg.asOf || AS_OF;
  // cfg.areas (a list) or cfg.area (one); absent means every area in the session.
  const areaFilter = Array.isArray(cfg.areas) && cfg.areas.length
    ? new Set(cfg.areas.map(a => clean(a))) : (cfg.area ? new Set([clean(cfg.area)]) : null);

  // Gather this session's members, by area.
  const byArea = new Map();
  for (const v of (records || [])) {
    const row = sessionRow(v, sessionId);
    if (!row) continue;
    const area = clean(row.area);
    if (!area) continue;
    if (areaFilter && !areaFilter.has(area)) continue;
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push({ v, row });
  }

  const counts = { members: 0, alreadyPlaced: 0, placed: 0, locked: 0, noRoster: 0,
    byAssigned: 0, byRequest: 0, byFill: 0, bySpread: 0, unplaced: 0,
    assignedOffRoster: 0, assignedTooYoung: 0, noAge: 0, heldTooYoung: 0 };
  const changes = [];
  const areasOut = [];
  const areasWithoutRoster = [];

  for (const area of [...byArea.keys()].sort()) {
    const people = byArea.get(area);
    counts.members += people.length;
    const duties = (roster && roster[area]) || [];
    if (!duties.length) {
      // No imported roster => no minimums => nothing to allocate against. Report, never guess.
      counts.noRoster += people.length;
      areasWithoutRoster.push({ area, members: people.length });
      continue;
    }

    // Roster rows -> specs, with a derived "Lead - X" alongside any duty needing leads.
    const specs = expandRoster(duties);
    const byName = new Map();                       // normalized duty -> spec
    for (const d of specs) byName.set(norm(d.duty), d);
    // The engine never fills lead duties: the area picks leads on the review screen.
    const fillable = specs.filter(d => !d.isLead);
    const tally = {};                               // duty -> assigned count
    const requested = {};                           // duty -> how many asked for it
    for (const d of specs) { tally[d.duty] = 0; requested[d.duty] = 0; }

    const notes = [];                               // per-person exceptions worth showing
    const note = (p, issue, extra) => notes.push(Object.assign(
      { user_id: p.v.user_id, name: nameOf(p.v), region: p.v.region, issue }, extra || {}));

    // Old enough for this duty on the EVENT DAY. No age on file => age-gated duties are refused
    // (never guessed), but an ungated duty is still fine.
    const ageOk = (p, spec) => {
      if (!spec.minAge) return true;
      return p.age != null && p.age >= spec.minAge;
    };

    // Rows that already carry a duty keep it, and still count toward that duty's total.
    const open = [];
    for (const p of people) {
      p.age = ageOfOn(p.v, asOf);
      p.assigned = clean(p.v.assigned_duty) || null;
      for (const r of requestsOf(p.v)) { const spec = byName.get(norm(r)); if (spec) requested[spec.duty]++; }
      const held = clean(p.row.duty);
      if (held) {
        counts.alreadyPlaced++;
        if (LOCKED_STATES.includes(p.row.state)) counts.locked++;
        if (tally[held] != null) tally[held]++; else tally[held] = 1;      // a duty since removed from the roster
        // Gap-fill never touches a holder, but a minimum age added AFTER they were placed leaves
        // them in a duty they no longer qualify for. Flag it; the area decides.
        const spec = byName.get(norm(held));
        if (spec && !ageOk(p, spec)) {
          counts.heldTooYoung++;
          note(p, "already holds a duty they are under the minimum age for",
            { duty: held, minAge: spec.minAge, age: p.age, state: clean(p.row.state) });
        }
        continue;
      }
      if (p.age == null) counts.noAge++;
      open.push(p);
    }

    const pool = shuffle(open, rng);
    const give = (p, duty, how) => {
      const rows = (Array.isArray(p.v.event_assignments) ? p.v.event_assignments : []).map(r =>
        (r && String(r.event) === sessionId && r.basis === "session")
          ? { ...r, duty, state: STATE_ALLOCATED } : r);
      changes.push({ user_id: p.v.user_id, region: p.v.region, rows, duty, area });
      tally[duty]++; counts.placed++; counts[how]++;
    };
    const under = (duty) => tally[duty] < (byName.get(norm(duty)) || { min: 0 }).min;
    // Interests that are real, fillable duties this person is old enough for, order preserved.
    const reqsOf = (p) => requestsOf(p.v).map(r => byName.get(norm(r)))
      .filter(spec => spec && !spec.isLead && ageOk(p, spec));

    // Pass 0 — assigned duties, UNCAPPED. A caller promised this person this duty.
    const afterAssigned = [];
    for (const p of pool) {
      if (!p.assigned) { afterAssigned.push(p); continue; }
      const spec = byName.get(norm(p.assigned));
      if (!spec || spec.isLead) {                   // named a duty this session x area doesn't roster
        counts.assignedOffRoster++;
        note(p, "assigned a duty that is not on this roster — placed by their interests instead",
          { duty: p.assigned });
        afterAssigned.push(p); continue;
      }
      if (!ageOk(p, spec)) {                        // the age rule outranks the promise, and says so
        counts.assignedTooYoung++;
        note(p, p.age == null
          ? "assigned an age-restricted duty but has no date of birth on file — placed elsewhere"
          : "assigned a duty they are under the minimum age for — placed elsewhere",
          { duty: p.assigned, minAge: spec.minAge, age: p.age });
        afterAssigned.push(p); continue;
      }
      give(p, spec.duty, "byAssigned");
    }

    // Pass 1 — a single expressed interest, capped. One pick is a strong signal, so they choose
    // before the multi-interest crowd; but a preference is not a promise, so the cap holds.
    const afterSingle = [];
    for (const p of afterAssigned) {
      const reqs = reqsOf(p);
      if (reqs.length !== 1) { afterSingle.push(p); continue; }
      if (under(reqs[0].duty)) give(p, reqs[0].duty, "byRequest"); else afterSingle.push(p);
    }

    // Pass 2 — multi-interest, capped at the minimum.
    const left = [];
    for (const p of afterSingle) {
      const hit = reqsOf(p).find(spec => under(spec.duty));
      if (hit) give(p, hit.duty, "byRequest"); else left.push(p);
    }

    // Pass 3 — fill the floors that are still short, from whoever is left and old enough.
    const stillLeft = [];
    for (const p of left) {
      const short = fillable.filter(spec => under(spec.duty) && ageOk(p, spec))
        .sort((a, b) => (a.min - tally[a.duty]) - (b.min - tally[b.duty]));   // biggest gap last -> pop
      if (!short.length) { stillLeft.push(p); continue; }
      give(p, short[short.length - 1].duty, "byFill");
    }

    // Pass 4 — surplus. Requested duty if they had one, else lowest fill ratio (proportional to min).
    for (const p of stillLeft) {
      const reqs = reqsOf(p);
      if (reqs.length) { give(p, reqs[0].duty, "bySpread"); continue; }
      const open2 = fillable.filter(spec => ageOk(p, spec));
      if (!open2.length) {                          // too young for every duty in their area
        counts.unplaced++;
        note(p, p.age == null
          ? "no date of birth on file and every duty in this area has a minimum age — not placed"
          : "under the minimum age of every duty in this area — not placed", { age: p.age });
        continue;
      }
      const best = open2.sort((a, b) =>
        (tally[a.duty] / Math.max(a.min, 1)) - (tally[b.duty] / Math.max(b.min, 1)))[0];
      give(p, best.duty, "bySpread");
    }

    // A lead duty is a row like any other — its shortfall IS "leads still to choose", so the old
    // leadsRequired/leadsChosen pair (and the row.lead boolean behind it) is gone: one way to be a
    // lead, which is to hold the lead duty.
    const rows = specs.map(spec => ({
      duty: spec.duty, min: spec.min, minAge: spec.minAge, checkIn: spec.checkIn,
      isLead: spec.isLead, leadOf: spec.leadOf,
      assigned: tally[spec.duty] || 0, requested: requested[spec.duty] || 0,
      shortfall: Math.max(0, spec.min - (tally[spec.duty] || 0)),
    })).sort((a, b) => a.duty.localeCompare(b.duty));
    // A duty someone still holds that is no longer on the roster (removed by a later import).
    const offRoster = Object.keys(tally).filter(d => !byName.has(norm(d)))
      .map(d => ({ duty: d, assigned: tally[d] }));

    areasOut.push({
      area, members: people.length, duties: rows, offRoster, notes,
      // Leads are ADDITIONAL people, so they are part of the minimum this area has to staff.
      minTotal: rows.reduce((n, r) => n + r.min, 0),
      assignedTotal: rows.reduce((n, r) => n + r.assigned, 0),
      shortfallTotal: rows.reduce((n, r) => n + r.shortfall, 0),
      leadsRequiredTotal: rows.filter(r => r.isLead).reduce((n, r) => n + r.min, 0),
      leadsChosenTotal: rows.filter(r => r.isLead).reduce((n, r) => n + r.assigned, 0),
    });
  }

  return { counts, areas: areasOut, areasWithoutRoster, changes,
    shortfallTotal: areasOut.reduce((n, a) => n + a.shortfallTotal, 0) };
}

module.exports = { planDuties, mulberry32, shuffle, requestsOf, sessionRow, theSessionRow,
  expandRoster, leadCheckIn, leadNameFor, isLeadName, ageAsOf, ageOfOn,
  LEAD_PREFIX, LEAD_RE,
  STATE_PENDING, STATE_ALLOCATED, STATE_SUBMITTED, STATE_ENTERED, LOCKED_STATES };
