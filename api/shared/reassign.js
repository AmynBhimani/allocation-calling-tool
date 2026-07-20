// Reassign everyone out of one area (Medical Services is being dissolved) into a set of target areas,
// balanced and AGE-GATED. Called PER REGION, because areas are staffed within a region's Didar — a
// Prairies volunteer can only serve a Prairies area, so each region's people are spread independently.
//
// Age gates mirror the allocation engine (api/allocate/alloc.js ASSIGN_TARGETS) so the two can never
// disagree about whether someone is old enough. Age itself is resolved by the shared definition
// (ageOfOn / AS_OF in api/shared/eventage.js): the person's `age` if present, else computed from
// birthday as of the event date. KEEP THE GATES BELOW IN SYNC WITH alloc.js.
//   Safety & Flow Management : 19+          Seniors & Mobility : 16-55
//   Reception & Hospitality  : 16+ (floor)
// Anyone eligible for NONE of the three (under 16, or no age on file) lands in Food Services — a
// low-risk area — rather than being forced into a gated one.
//
// Assignment rule for the eligible: honour interest first (if they listed an eligible target, they go
// to one of those), otherwise fill whichever eligible target keeps the split even. Among candidates we
// pick the least-loaded so far (ties break by target order). Deterministic (stable sort + fixed
// tie-break) so the dry-run and the commit produce the identical plan.
const { AS_OF, ageOfOn } = require("./eventage");

const clean = (s) => String(s == null ? "" : s).trim();
const norm = (s) => clean(s).toLowerCase();

const DEFAULT_FROM = "Medical Services";
// Keep in sync with alloc.js ASSIGN_TARGETS.
const TARGET_GATES = [
  { area: "Safety & Flow Management", min: 19, max: null },
  { area: "Seniors & Mobility", min: 16, max: 55 },
  { area: "Reception & Hospitality", min: null, max: null },
];
const OVERFLOW_AREA = "Food Services";   // under-16 / no-age land here (low-risk)
const DEFAULT_TARGETS = TARGET_GATES.map(g => g.area);

// Same gate as alloc.js eligible(): 16 is the floor unless a lower min is set; max is inclusive.
function ageEligible(age, gate) {
  const min = (gate.min != null) ? gate.min : 16;
  if (age == null || age < min) return false;
  if (gate.max != null && age > gate.max) return false;
  return true;
}

// records = ONE region's records. Returns { from, targets, overflow, count, counts, byReason, plan }.
// counts is keyed by every landing area (the three targets + the overflow area).
function planReassign(records, opts = {}) {
  const from = opts.from || DEFAULT_FROM;
  const gates = (opts.gates && opts.gates.length) ? opts.gates : TARGET_GATES;
  const overflow = opts.overflow || OVERFLOW_AREA;
  const targetAreas = gates.map(g => g.area);
  const counts = {}; targetAreas.forEach(a => { counts[a] = 0; }); counts[overflow] = 0;
  const byReason = { interest: 0, balanced: 0, overflow: 0 };
  const plan = [];

  const people = (records || []).filter(v => v && norm(v.final_area) === norm(from));
  people.sort((a, b) => String(a.region || "").localeCompare(String(b.region || "")) || String(a.user_id).localeCompare(String(b.user_id)));

  for (const v of people) {
    const age = ageOfOn(v, AS_OF);
    const prefs = Array.isArray(v.pref_areas) ? v.pref_areas : [];
    const eligibleGates = gates.filter(g => ageEligible(age, g));
    let pick, reason;
    if (!eligibleGates.length) {
      pick = overflow; reason = "overflow";                 // under 16 / no age on file -> low-risk area
    } else {
      const interested = eligibleGates.filter(g => prefs.some(p => norm(p) === norm(g.area)));
      const cand = (interested.length ? interested : eligibleGates).map(g => g.area);
      pick = cand[0];
      for (const a of cand) if (counts[a] < counts[pick]) pick = a;   // least-loaded, ties -> earlier target
      reason = interested.length ? "interest" : "balanced";
    }
    counts[pick]++; byReason[reason]++;
    plan.push({ user_id: v.user_id, region: v.region, name: (clean((v.first || "") + " " + (v.last || "")) || ("#" + v.user_id)),
      from, to: pick, reason, age: (age == null ? null : age) });
  }
  return { from, targets: targetAreas, overflow, count: plan.length, counts, byReason, plan };
}

// Move ONE person: point final_area and their existing event_assignments rows at the new area (duty
// selection reads the row's area), keeping session/state on those rows. Records the old area for audit.
function applyReassign(v, to, from, actor, nowIso) {
  v.referred_from = v.final_area;
  v.final_area = to;
  for (const row of (Array.isArray(v.event_assignments) ? v.event_assignments : [])) {
    if (row && (norm(row.area) === norm(from) || !clean(row.area))) row.area = to;
  }
  v.activity_log = v.activity_log || [];
  v.activity_log.push({ ts: nowIso, actor, action: "area_reassigned", from, to,
    note: from + " dissolved; reassigned by interest, balance, and age gate." });
}

module.exports = { planReassign, applyReassign, ageEligible, DEFAULT_FROM, DEFAULT_TARGETS, TARGET_GATES, OVERFLOW_AREA };
