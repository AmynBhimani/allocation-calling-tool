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

// Allocations by Ceremony JK × area: for each JK, how many volunteers landed in each area.
// Only counts people who actually hold an area (final_area set); leadership is excluded.
function rollupByJk(records, acc) {
  const byJk = (acc && acc.byJk) || {};
  const areas = (acc && acc.areas) || new Set();
  for (const v of records || []) {
    if (v.callable_status === "Leadership - Do Not Allocate") continue;
    const area = v.final_area;
    if (!area) continue;
    const jk = v.ceremony_jk || "(no JK)";
    areas.add(area);
    const row = byJk[jk] || (byJk[jk] = {});
    row[area] = (row[area] || 0) + 1;
  }
  return { byJk, areas };
}

// Shape the JK rollup into sorted rows [{ jk, counts:{area:n}, total }] plus per-area column totals.
function jkGrid(byJk, areasArr) {
  const rows = Object.keys(byJk).sort().map(jk => {
    const counts = byJk[jk];
    const total = areasArr.reduce((s, a) => s + (counts[a] || 0), 0);
    return { jk, counts, total };
  });
  const colTotals = {};
  let grand = 0;
  for (const a of areasArr) { colTotals[a] = rows.reduce((s, r) => s + (r.counts[a] || 0), 0); grand += colTotals[a]; }
  return { rows, colTotals, grand };
}

module.exports = { lastOutcome, blankCounts, rollupRecords, rowsFromByArea, rollupByJk, jkGrid };
