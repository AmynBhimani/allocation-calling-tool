// Applies the dispositions decided from the Better Impact cross-reference (who is accepted in the webapp
// but shouldn't be). THREE dispositions, each idempotent and safe to re-run:
//
//   "block"      — terminal. The ceremony JK is outside BC/Prairies/Edmonton, so they belong to a
//                  different Didar. Un-accept, clear the duty, drop them off every caller list, and set
//                  assignability = "blocked". They can never land on a duty list again and there is no
//                  Activate path.
//   "inactivate" — reversible. No visit registration yet, so they haven't expressed interest — but they
//                  still could. Same removal as block, assignability = "inactive". An admin can Activate
//                  them later (see activate() below), which returns them to the normal flow.
//   "needs_bi"   — NOT a removal. They're a normal, accepted volunteer who simply has no Better Impact
//                  account. They keep their acceptance and their area, but we mark no_bi_account and PULL
//                  THEM OFF any lineup (submitted -> allocated). The duty-review toggle then refuses to
//                  re-add them until the account exists; when it does (a re-import flips no_bi_account
//                  back to false), the toggle returns on its own.
//
// unaccept + clear here is byte-for-byte the shape api/accepted's withdraw produces, so a disposed record
// is indistinguishable from a withdrawn one except for the assignability flag and the reason on the log.
const { ASSIGN_BLOCKED, ASSIGN_INACTIVE, ASSIGN_ACTIVE, assignabilityOf, isAcceptedVolunteer } = require("./rollup");

const clean = (s) => String(s == null ? "" : s).trim();
const rows = (v) => (Array.isArray(v && v.event_assignments) ? v.event_assignments : []);
const onLineup = (v) => rows(v).some(r => r && r.basis === "session" && clean(r.state) === "submitted");

// Mirrors api/accepted's unaccept()+clearDuties(): reopen the record, drop iVol-ready and the outcome,
// clear every duty (which also drops those rows off the lineup: state -> pending), and take them off
// their caller's list. final_area is deliberately KEPT so an Activated person resumes in their own area.
function unacceptAndClear(v, actor, nowIso) {
  v.activity_log = v.activity_log || [];
  v.activity_log.push({ ts: nowIso, actor, action: "reopen", from: v.call_outcome || null, via: "disposition" });
  v.call_done = false; v.call_outcome = null; v.ivol_ready = false;
  let dutiesCleared = 0;
  for (const r of rows(v)) { if (clean(r.duty)) dutiesCleared++; r.duty = ""; r.state = "pending"; }
  v.assigned_duty = null;
  v.assigned_caller = null;
  return dutiesCleared;
}

function setAssignability(v, value, reason, actor, nowIso) {
  const wasAccepted = isAcceptedVolunteer(v);
  const dutiesCleared = unacceptAndClear(v, actor, nowIso);
  v.assignability = value;
  v.assignability_reason = clean(reason);
  v.assignability_at = nowIso;
  v.assignability_by = actor;
  v.activity_log.push({ ts: nowIso, actor, action: "assignability_set", to: value, reason: clean(reason) });
  return { wasAccepted, dutiesCleared };
}

// submitted -> allocated on every session row; they keep the allocated duty, just come off the lineup.
function pullOffLineup(v) {
  let pulled = 0;
  for (const r of rows(v)) {
    if (r && r.basis === "session" && clean(r.state) === "submitted") { r.state = "allocated"; delete r.notified_at; pulled++; }
  }
  return pulled;
}

function setNeedsBi(v, reason, actor, nowIso) {
  const before = !!v.no_bi_account;
  v.no_bi_account = true;
  const pulled = pullOffLineup(v);
  v.activity_log = v.activity_log || [];
  v.activity_log.push({ ts: nowIso, actor, action: "needs_bi_flagged", reason: clean(reason), pulledOffLineup: pulled });
  return { markedNoBi: !before, pulledOffLineup: pulled };
}

// Reverse an "inactive" (never a "blocked" — that is terminal; the caller enforces it). Sets active and
// clears the reason. The person stays un-accepted, so they re-enter the normal allocation/calling flow.
function activate(v, actor, nowIso) {
  const from = assignabilityOf(v);
  v.assignability = ASSIGN_ACTIVE;
  delete v.assignability_reason; delete v.assignability_at; delete v.assignability_by;
  v.activity_log = v.activity_log || [];
  v.activity_log.push({ ts: nowIso, actor, action: "activated", from });
  return { from };
}

const DISPOSITIONS = new Set(["block", "inactivate", "needs_bi"]);

// True when applying `disposition` would change nothing — used to make commit idempotent and to label the
// dry-run. needs_bi is naturally idempotent (re-marking is a no-op, re-pulling finds nothing), so it only
// counts as "already" when the flag is set AND they hold no submitted row.
function alreadyApplied(v, disposition) {
  if (disposition === "block") return assignabilityOf(v) === ASSIGN_BLOCKED;
  if (disposition === "inactivate") return assignabilityOf(v) === ASSIGN_INACTIVE;
  if (disposition === "needs_bi") return !!v.no_bi_account && !onLineup(v);
  return false;
}

function applyDisposition(v, disposition, reason, actor, nowIso) {
  if (disposition === "block") return { disposition, ...setAssignability(v, ASSIGN_BLOCKED, reason, actor, nowIso) };
  if (disposition === "inactivate") return { disposition, ...setAssignability(v, ASSIGN_INACTIVE, reason, actor, nowIso) };
  if (disposition === "needs_bi") return { disposition, ...setNeedsBi(v, reason, actor, nowIso) };
  return null;
}

module.exports = { applyDisposition, activate, alreadyApplied, onLineup, pullOffLineup, DISPOSITIONS };
