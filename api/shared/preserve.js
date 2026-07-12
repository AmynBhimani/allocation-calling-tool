// Single source of truth for the import / sync preservation guard. A volunteer is "touched" — carrying
// work that a BI import or refresh must NOT overwrite — if reconciliation, calling, or allocation has
// acted on them in ANY way. Crucially this includes a decided area (final_area) and in-reconciliation
// state (conflict_claims), not just call/activity markers: without those checks, a re-import could send a
// reconciled or assigned person back to Unassigned, wiping the review's decision. A genuinely fresh
// person (Unassigned, no area, no claims, no activity) is NOT touched, so BI can refresh them normally.
function isTouched(v) {
  if (!v) return false;
  return (Array.isArray(v.activity_log) && v.activity_log.length > 0)   // called / edited / any logged action
    || !!v.assigned_caller                                              // on a caller's list
    || !!v.ivol_entered                                                 // entered into Better Impact
    || v.callable_status === "Leadership - Do Not Allocate"             // leadership
    || !!v.no_bi_account                                                // write-in / injected, no BI account
    || !!v.released_to_pool                                             // released back to the pool
    || !!v.final_area                                                   // has a decided / assigned area — real work
    || (Array.isArray(v.conflict_claims) && v.conflict_claims.length > 0); // in reconciliation
}

module.exports = { isTouched };
