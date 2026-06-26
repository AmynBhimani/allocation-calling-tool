// Single source of truth for the dashboard rollup (counts by area × status).
// Used by /api/reports (the live dashboard) AND the daily digest email, so the two never drift.

// Walk the activity log in order: an "outcome" sets the current outcome; a later "reopen" clears it
// (they changed their mind and are back in the active queue).
function lastOutcome(v) {
  let o = null;
  for (const e of (v && v.activity_log) || []) {
    if (e.action === "outcome") o = e.outcome;
    else if (e.action === "reopen") o = null;
  }
  return o;
}

const blankCounts = () => ({ assignedDuty: 0, accepted: 0, callPending: 0, declined: 0 });

// Fold a batch of records into byArea + totals. Pass an accumulator to combine multiple regions,
// or omit it to get a fresh per-region tally. Mirrors api/reports exactly.
function rollupRecords(records, acc) {
  const byArea = (acc && acc.byArea) || {};
  const totals = (acc && acc.totals) || blankCounts();
  for (const v of records || []) {
    if (v.callable_status === "Leadership - Do Not Allocate") continue;     // outside the callable pipeline
    const area = v.final_area || "(no area)";
    const b = byArea[area] || (byArea[area] = blankCounts());
    const lo = lastOutcome(v);
    if (lo === "Withdrew") { b.declined++; totals.declined++; continue; }   // the only true decline
    if (lo === "Duplicate") continue;                                       // data-cleanup drop-out
    if (v.callable_status === "Stable") { b.assignedDuty++; totals.assignedDuty++; }
    const isAccepted = !!v.ivol_ready || lo === "Accepted";
    const isCallPending = !!v.assigned_caller && !v.call_done;              // with a caller, call not completed
    if (isAccepted) { b.accepted++; totals.accepted++; }
    if (isCallPending) { b.callPending++; totals.callPending++; }
  }
  return { byArea, totals };
}

const rowsFromByArea = (byArea) => Object.keys(byArea).sort().map(area => ({ area, ...byArea[area] }));

module.exports = { lastOutcome, blankCounts, rollupRecords, rowsFromByArea };
