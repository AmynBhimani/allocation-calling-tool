// Duty allocation (Phase 4a) — pure function over stored records. No I/O.
// Deterministic given the same records + seed, so preview and commit always match.
//
// Runs per SESSION. For each area in that session it reads the imported roster (minimum + leads per
// duty, Phase 3) and gives every session member exactly one duty:
//
//   Pass 1 — requests, CAPPED AT THE MINIMUM. Each person gets the first duty on their interest list
//            that is still under its floor. The cap is the whole point: without it everyone piles
//            into the popular duty and the unpopular one starves below its minimum.
//   Pass 2 — fill the remaining floors from whoever is left, at random.
//   Pass 3 — surplus. Their requested duty if they had one (the floor is a floor, not a cap), else
//            spread by lowest fill ratio, which lands people proportionally to the minimums.
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
  const onlyArea = cfg.area ? clean(cfg.area) : null;

  // Gather this session's members, by area.
  const byArea = new Map();
  for (const v of (records || [])) {
    const row = sessionRow(v, sessionId);
    if (!row) continue;
    const area = clean(row.area);
    if (!area) continue;
    if (onlyArea && area !== onlyArea) continue;
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push({ v, row });
  }

  const counts = { members: 0, alreadyPlaced: 0, placed: 0, locked: 0, noRoster: 0, byRequest: 0, byFill: 0, bySpread: 0 };
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

    const byName = new Map();                       // normalized duty -> spec
    for (const d of duties) byName.set(norm(d.duty), { duty: clean(d.duty), min: Number(d.min) || 0, leads: Number(d.leads) || 0 });
    const tally = {};                               // duty -> assigned count
    const requested = {};                           // duty -> how many asked for it
    const leadsChosen = {};
    for (const [, d] of byName) { tally[d.duty] = 0; requested[d.duty] = 0; leadsChosen[d.duty] = 0; }

    // Rows that already carry a duty keep it, and still count toward that duty's total.
    const open = [];
    for (const p of people) {
      for (const r of requestsOf(p.v)) { const spec = byName.get(norm(r)); if (spec) requested[spec.duty]++; }
      const held = clean(p.row.duty);
      if (held) {
        counts.alreadyPlaced++;
        if (LOCKED_STATES.includes(p.row.state)) counts.locked++;
        if (tally[held] != null) tally[held]++; else tally[held] = 1;      // a duty since removed from the roster
        if (p.row.lead) leadsChosen[held] = (leadsChosen[held] || 0) + 1;
        continue;
      }
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

    // Pass 1 — requests, capped at the minimum.
    const left = [];
    for (const p of pool) {
      const reqs = requestsOf(p.v).map(r => byName.get(norm(r))).filter(Boolean);
      const hit = reqs.find(spec => under(spec.duty));
      if (hit) give(p, hit.duty, "byRequest"); else left.push(p);
    }

    // Pass 2 — fill the floors that are still short, from whoever is left.
    const stillLeft = [];
    for (const p of left) {
      const short = [...byName.values()].filter(spec => under(spec.duty))
        .sort((a, b) => (a.min - tally[a.duty]) - (b.min - tally[b.duty]));   // biggest gap last -> pop
      if (!short.length) { stillLeft.push(p); continue; }
      give(p, short[short.length - 1].duty, "byFill");
    }

    // Pass 3 — surplus. Requested duty if they had one, else lowest fill ratio (proportional to min).
    for (const p of stillLeft) {
      const reqs = requestsOf(p.v).map(r => byName.get(norm(r))).filter(Boolean);
      if (reqs.length) { give(p, reqs[0].duty, "bySpread"); continue; }
      const best = [...byName.values()].sort((a, b) =>
        (tally[a.duty] / Math.max(a.min, 1)) - (tally[b.duty] / Math.max(b.min, 1)))[0];
      give(p, best.duty, "bySpread");
    }

    const rows = [...byName.values()].map(spec => ({
      duty: spec.duty, min: spec.min, leadsRequired: spec.leads,
      assigned: tally[spec.duty] || 0, requested: requested[spec.duty] || 0,
      leadsChosen: leadsChosen[spec.duty] || 0,
      shortfall: Math.max(0, spec.min - (tally[spec.duty] || 0)),
    })).sort((a, b) => a.duty.localeCompare(b.duty));
    // A duty someone still holds that is no longer on the roster (removed by a later import).
    const offRoster = Object.keys(tally).filter(d => !byName.has(norm(d)))
      .map(d => ({ duty: d, assigned: tally[d] }));

    areasOut.push({
      area, members: people.length, duties: rows, offRoster,
      minTotal: rows.reduce((n, r) => n + r.min, 0),
      assignedTotal: rows.reduce((n, r) => n + r.assigned, 0),
      shortfallTotal: rows.reduce((n, r) => n + r.shortfall, 0),
      leadsRequiredTotal: rows.reduce((n, r) => n + r.leadsRequired, 0),
      leadsChosenTotal: rows.reduce((n, r) => n + r.leadsChosen, 0),
    });
  }

  return { counts, areas: areasOut, areasWithoutRoster, changes,
    shortfallTotal: areasOut.reduce((n, a) => n + a.shortfallTotal, 0) };
}

module.exports = { planDuties, mulberry32, shuffle, requestsOf, sessionRow,
  STATE_PENDING, STATE_ALLOCATED, STATE_SUBMITTED, STATE_ENTERED, LOCKED_STATES };
