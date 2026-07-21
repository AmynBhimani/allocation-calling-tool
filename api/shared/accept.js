// Shared "can this person be marked Accepted without a call" guard, used by both the bulk-accept endpoint
// and the team-file accept. Returns null when eligible, otherwise a skip reason (most-definitive first).
const { LEADERSHIP } = require("./status");
const { lastOutcome, notAssignable } = require("./rollup");

function acceptGuard(v) {
  if (v.callable_status === LEADERSHIP) return "leadership";
  if (notAssignable(v)) return "notAssignable";     // blocked / inactive: off the pipeline, never auto-accepted
  if (!!v.ivol_ready || v.call_outcome === "Accepted" || lastOutcome(v) === "Accepted") return "alreadyAccepted";
  if (!v.final_area) return "noArea";
  const claims = Array.isArray(v.conflict_claims) ? v.conflict_claims : [];
  if (v.callable_status === "In reconciliation" || claims.length >= 2) return "inReconciliation";
  if (v.assigned_caller) return "assignedToCaller";   // already on a caller's list — leave them to the caller
  return null;
}

module.exports = { acceptGuard };
