// Event wrap-up: calling has stopped, so we sweep everyone who was assigned an area but never accepted
// and sort them into action buckets. This reuses acceptGuard for the "can't accept" reasons and only
// diverges on people already on a caller's list — the blanket accept is supposed to take them too, EXCEPT
// where the caller already logged an answer:
//
//   accept      -> has an area, not yet accepted, not in reconciliation, not leadership, and the caller
//                  either never reached an outcome (or they were never on a list). These are the ones who
//                  would have been accepted if there'd been time to call.
//   unreached   -> the caller tried and couldn't connect (No answer / Emailed) or reached them but got no
//                  decision (Thinking). NOT accepted — they get the "we couldn't reach you" email instead.
//   leaveAlone  -> the caller already got a definitive no: Withdrew, or Duplicate (a write-in already
//                  registered). Accepting these would re-accept someone who declined — the whole reason
//                  we classify by outcome instead of a blanket caller-list override.
//
// Everything else (leadership / already-accepted / no area / in reconciliation) is a skip, reported so
// nothing is silent. Reconciliation people stay in reconciliation, by design.
const { acceptGuard } = require("./accept");

// The caller's non-terminal outcomes mean "couldn't get a decision" -> the no-response cohort.
const UNREACHED_OUTCOMES = new Set(["No answer", "Thinking", "Emailed"]);
// Terminal "no" outcomes that keep their area + caller assignment and must never be re-accepted.
const LEAVE_ALONE_OUTCOMES = new Set(["Withdrew", "Duplicate"]);

// One of: leadership | alreadyAccepted | noArea | inReconciliation | unreached | leaveAlone | accept
function classify(v) {
  const g = acceptGuard(v);
  // acceptGuard's hard skips stand as-is; only "assignedToCaller" (on a list) is overridden and sent
  // through the outcome split, because the wrap-up is meant to accept caller-list people too.
  if (g && g !== "assignedToCaller") return g;
  const oc = String((v && v.call_outcome) || "");
  if (UNREACHED_OUTCOMES.has(oc)) return "unreached";
  if (LEAVE_ALONE_OUTCOMES.has(oc)) return "leaveAlone";
  return "accept";
}

// The exact state a caller's "Accepted" outcome produces (matches api/bulkaccept), so wrapped-up people
// flow to the iVol report and count as accepted everywhere. Idempotent in effect: re-running the sweep
// re-classifies an already-accepted person as alreadyAccepted, so this never runs on them twice.
function applyAccept(v, actor, nowIso) {
  v.activity_log = v.activity_log || [];
  v.activity_log.push({ ts: nowIso, actor, action: "outcome", outcome: "Accepted", bulk: true,
    note: "Mass-accepted (event wrap-up; assigned an area, no call)." });
  v.call_outcome = "Accepted"; v.call_done = true; v.ivol_ready = true;
}

module.exports = { classify, applyAccept, UNREACHED_OUTCOMES, LEAVE_ALONE_OUTCOMES };
