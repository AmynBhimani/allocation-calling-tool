// Turning a volunteer back into an allocation-pool member. One mutation, two callers that disagree
// about WHEN it is allowed — so the rule lives with the caller, not in here.
//
//   api/release  — bulk-releases people HELD ASIDE by review. It refuses anyone a caller has acted on
//                  (callerLocked): never yank someone out from under an active call.
//   api/accepted — the Duty Team deliberately repooling someone who ACCEPTED and then changed their
//                  mind. Every such person is callerLocked by definition, so that rule cannot apply
//                  here; the un-accept that runs first IS the decision.
//
// The guard used to live inside repool(). Keeping it there would have made the accepted-screen path
// silently no-op for anyone already entered in Better Impact — ivol_entered keeps callerLocked true
// on purpose, and clearing it would erase the fact that iVol has work to undo. api/release's call
// site already tests callerLocked and isHeldAside before calling this, so moving the guard out
// changes nothing there.
const { computeCallableStatus, callerLocked } = require("./status");

// Pure mutation. Always applies; the caller decides whether it should.
function repool(v, actor) {
  v.activity_log = v.activity_log || [];
  const from = v.final_area || null;
  v.final_area = null;
  v.affinity_flag = false;
  v.never_reviewed = true;         // re-enters the allocation pool
  v.conflict_claims = [];
  v.released_to_pool = true;       // durable: transfer won't re-hold; import preserves it
  v.event_assignments = [];
  v.callable_status = computeCallableStatus(v);   // -> Unassigned
  v.activity_log.push({ ts: new Date().toISOString(), actor: actor || "release", action: "release_to_pool", from });
  return true;
}

// The release-tool rule: never repool someone a caller has already acted on.
const canRepool = (v) => !callerLocked(v);

module.exports = { repool, canRepool };
