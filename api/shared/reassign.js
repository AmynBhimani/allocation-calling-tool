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
const { isAcceptedVolunteer } = require("./rollup");

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
// "Committed to a Medical duty" = they accepted (call outcome / ivol_ready) OR they're on a duty lineup
// (a submitted/entered roster row). Either way they've taken up a Medical assignment and must not be moved
// by a second reassignment. Used with planReassign({ keepCommitted: true }).
const LINEUP_STATES = new Set(["submitted", "entered"]);
function onLineup(v) {
  return Array.isArray(v && v.event_assignments) &&
    v.event_assignments.some(r => r && LINEUP_STATES.has(String((r && r.state) || "").trim().toLowerCase()));
}
function hasAcceptedMedicalDuty(v) {
  return isAcceptedVolunteer(v) || onLineup(v);
}

function planReassign(records, opts = {}) {
  const from = opts.from || DEFAULT_FROM;
  const keepCommitted = !!opts.keepCommitted;
  const gates = (opts.gates && opts.gates.length) ? opts.gates : TARGET_GATES;
  const overflow = opts.overflow || OVERFLOW_AREA;
  const targetAreas = gates.map(g => g.area);
  const counts = {}; targetAreas.forEach(a => { counts[a] = 0; }); counts[overflow] = 0;
  const byReason = { interest: 0, balanced: 0, overflow: 0 };
  const plan = [];

  let people = (records || []).filter(v => v && norm(v.final_area) === norm(from));

  // When keepCommitted is set, anyone who accepted or is on a Medical duty lineup stays put; only the
  // volunteers who never took up a Medical duty are moved.
  let kept = 0, keptAccepted = 0, keptLineup = 0; const keptSample = [];
  if (keepCommitted) {
    const staying = people.filter(hasAcceptedMedicalDuty);
    kept = staying.length;
    for (const v of staying) { if (isAcceptedVolunteer(v)) keptAccepted++; if (onLineup(v)) keptLineup++; }
    for (const v of staying.slice(0, 25)) keptSample.push({ user_id: v.user_id, region: v.region,
      name: (clean((v.first || "") + " " + (v.last || "")) || ("#" + v.user_id)),
      accepted: isAcceptedVolunteer(v), onLineup: onLineup(v), duty: dutyOnLineup(v) });
    people = people.filter(v => !hasAcceptedMedicalDuty(v));
  }

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
  return { from, targets: targetAreas, overflow, count: plan.length, counts, byReason, plan, kept, keptAccepted, keptLineup, keptSample };
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

// ---- Reverse (restore) ----------------------------------------------------------------------------
// The reassignment above changed ONLY final_area and the matching row areas, and stamped an
// "area_reassigned" activity entry naming the area it moved the person out of. That entry is the exact,
// reliable record of who was moved. Restoring = point final_area and those rows back to the original
// area. Because nothing else was touched (accepted status, duty, state, confirmation all preserved),
// this returns each person to their exact pre-reassignment state — including anyone who had already
// accepted a Medical duty.
function wasReassignedFrom(v, from) {
  return Array.isArray(v && v.activity_log) &&
    v.activity_log.some(l => l && l.action === "area_reassigned" && norm(l.from) === norm(from));
}

function dutyOnLineup(v) {
  for (const row of (Array.isArray(v && v.event_assignments) ? v.event_assignments : [])) {
    if (row && clean(row.duty)) return clean(row.duty);
  }
  return "";
}

// records = ONE region's records. from defaults to Medical Services. Returns the plan of who to restore.
function planRestore(records, opts = {}) {
  const from = opts.from || DEFAULT_FROM;
  const plan = [];
  const byArea = {};
  let accepted = 0;
  for (const v of (records || [])) {
    if (!wasReassignedFrom(v, from)) continue;
    if (norm(v.final_area) === norm(from)) continue;   // already back in the original area — idempotent
    const cur = clean(v.final_area);
    byArea[cur] = (byArea[cur] || 0) + 1;
    const wasAccepted = isAcceptedVolunteer(v);
    if (wasAccepted) accepted++;
    plan.push({ user_id: v.user_id, region: v.region,
      name: (clean((v.first || "") + " " + (v.last || "")) || ("#" + v.user_id)),
      currentArea: cur, accepted: wasAccepted, duty: dutyOnLineup(v) });
  }
  return { from, count: plan.length, accepted, byArea, plan };
}

// Reverse one person: rows currently in their (reassigned-to) area go back to `from`; final_area goes
// back to `from`; the reassignment's referred_from marker is cleared; a revert entry is logged.
function applyRestore(v, from, actor, nowIso) {
  const currentArea = v.final_area;
  for (const row of (Array.isArray(v.event_assignments) ? v.event_assignments : [])) {
    if (row && norm(row.area) === norm(currentArea)) row.area = from;
  }
  v.final_area = from;
  if (norm(v.referred_from) === norm(from)) v.referred_from = null;
  v.activity_log = v.activity_log || [];
  v.activity_log.push({ ts: nowIso, actor, action: "area_reassign_reverted", from: currentArea, to: from,
    note: "Restored to " + from + " (reassignment reverted)." });
}

module.exports = { planReassign, applyReassign, ageEligible, hasAcceptedMedicalDuty, onLineup, wasReassignedFrom, planRestore, applyRestore, DEFAULT_FROM, DEFAULT_TARGETS, TARGET_GATES, OVERFLOW_AREA };
