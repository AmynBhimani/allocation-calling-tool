// Single source of truth for a volunteer's callable_status and for seeding per-event rows.
// Status rule (closes the assign-leak):
//   • a confirmed final_area  -> "Stable"           (only Stable is callable; api/assign gates on it)
//   • else 2+ competing claims -> "In reconciliation"
//   • else                     -> "Unassigned"
//   • Leadership is preserved as-is (it lives only in callable_status).
const LEADERSHIP = "Leadership - Do Not Allocate";

function computeCallableStatus(v) {
  if (!v) return "Unassigned";
  if (v.callable_status === LEADERSHIP) return LEADERSHIP;     // preserve do-not-allocate
  if (v.final_area) return "Stable";                           // confirmed area wins
  const claims = Array.isArray(v.conflict_claims) ? v.conflict_claims : [];
  if (claims.length > 1) return "In reconciliation";          // contested, not yet resolved
  return "Unassigned";                                        // no confirmed area yet
}

// Seed/refresh a person's event_assignments from their confirmed final_area.
// One row per active Didar whose regions include the person's region. Rows are
// {event, area, candidate_duties, duty, basis, state}. basis is "pending" until session
// JK lists exist (session vs. support is computed later). Existing rows are preserved:
// a row for an event is only added if absent; the caller's captured rows are never dropped.
function seedEventAssignments(v, didars) {
  const existing = Array.isArray(v.event_assignments) ? v.event_assignments.slice() : [];
  if (!v.final_area) return existing;                          // nothing to seed until reconciled
  const region = v.region;
  const byEvent = new Set(existing.map(r => r && r.event));
  for (const d of (didars || [])) {
    if (d.active === false) continue;
    const regions = Array.isArray(d.regions) ? d.regions : [];
    if (!regions.includes(region)) continue;                  // Didar doesn't cover this person
    if (byEvent.has(d.id)) continue;                          // already has a row for this event
    existing.push({ event: d.id, area: v.final_area, candidate_duties: [], duty: "", basis: "pending", state: "pending" });
    byEvent.add(d.id);
  }
  return existing;
}

module.exports = { computeCallableStatus, seedEventAssignments, LEADERSHIP };
