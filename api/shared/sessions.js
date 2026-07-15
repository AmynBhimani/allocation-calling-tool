// Session helpers shared by the session allocation (api/sessionalloc) and by reporting
// (api/reports, api/dailyDigest). The JK -> session mapping lives here ONCE so the mapping used to
// REPORT can never drift from the mapping used to ALLOCATE — if those two disagreed, the dashboard
// would quietly lie about who is in which session.
//
// Reporting reads COMMITTED rows (stored event_assignments), not a live recompute: the dashboard
// shows what has actually been committed and would go to iVolunteer. sessionHealth() is the
// companion signal that says when the committed picture has gone stale and needs a re-run.

// JK strings come from live data and from the Events checklist (built from that same data), so they
// normally match exactly. Normalising anyway means a stray case/spacing difference can't silently
// strand a whole Jamatkhana.
const normJk = (s) => String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase();
const clean = (s) => String(s == null ? "" : s).trim();

// jk -> [{id,name,label}]. A jk in 2+ sessions is a mapping error: reported, never resolved by guessing.
function buildJkIndex(sessions) {
  const idx = new Map();
  for (const s of (sessions || [])) {
    for (const jk of (s.jamatkhanas || [])) {
      const k = normJk(jk);
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, []);
      const list = idx.get(k);
      if (!list.some(x => x.id === s.id)) list.push({ id: s.id, name: s.name, label: clean(jk) });
    }
  }
  return idx;
}
// The single session a Jamatkhana belongs to: null when unmapped, null when claimed by 2+ sessions.
function sessionForJk(jkIndex, jk) {
  const hit = jkIndex.get(normJk(jk));
  return hit && hit.length === 1 ? String(hit[0].id) : null;
}
const sessionIdSet = (sessions) => new Set((sessions || []).map(s => String(s.id)));

// Committed rosters: session -> area -> n, counted from stored event_assignments rows. Counts every
// row pointing at a known session, so Phase 4's support volunteers will fold in automatically
// (a session's roster is everyone serving it, primary or support).
function rollupBySession(records, sessionIds, acc) {
  const bySession = (acc && acc.bySession) || {};
  const areas = (acc && acc.areas) || new Set();
  for (const v of (records || [])) {
    for (const r of (Array.isArray(v.event_assignments) ? v.event_assignments : [])) {
      if (!r || r.event == null) continue;
      if (!sessionIds.has(String(r.event))) continue;      // Didar rows / unknown events aren't sessions
      const area = clean(r.area) || clean(v.final_area) || "(no area)";
      areas.add(area);
      const row = bySession[String(r.event)] || (bySession[String(r.event)] = {});
      row[area] = (row[area] || 0) + 1;
    }
  }
  return { bySession, areas };
}

// Area rows x session columns — there are ~11 areas but only a handful of sessions, so this is the
// orientation that fits on a screen (and in an email).
function sessionGrid(bySession, sessionList, areasArr) {
  const rows = (areasArr || []).slice().sort().map(area => {
    const counts = {};
    let total = 0;
    for (const s of (sessionList || [])) {
      const n = ((bySession[String(s.id)] || {})[area]) || 0;
      counts[String(s.id)] = n; total += n;
    }
    return { area, counts, total };
  });
  const colTotals = {};
  let grand = 0;
  for (const s of (sessionList || [])) {
    colTotals[String(s.id)] = rows.reduce((a, r) => a + (r.counts[String(s.id)] || 0), 0);
    grand += colTotals[String(s.id)];
  }
  return { rows, colTotals, grand };
}

// Is the committed picture still current? Both numbers mean "re-run the Sessions screen".
//   notInSession : accepted, holds an area, but is in no session yet
//   needsRerun   : committed to a session their Jamatkhana no longer maps to, OR still holding a
//                  session row after being reopened / declining (they're no longer accepted)
function sessionHealth(records, sessions, isAccepted, acc) {
  const out = acc || { notInSession: 0, needsRerun: 0 };
  const idx = buildJkIndex(sessions);
  const ids = sessionIdSet(sessions);
  for (const v of (records || [])) {
    const rows = (Array.isArray(v.event_assignments) ? v.event_assignments : [])
      .filter(r => r && r.event != null && ids.has(String(r.event)));
    const accepted = isAccepted(v);
    if (!accepted) { if (rows.length) out.needsRerun++; continue; }   // withdrew but still on a roster
    if (!clean(v.final_area)) continue;                               // no area to place yet
    const target = sessionForJk(idx, v.ceremony_jk);
    if (!rows.length) { out.notInSession++; continue; }
    if (target && !rows.some(r => String(r.event) === target)) out.needsRerun++;   // JK/mapping moved
  }
  return out;
}

module.exports = { normJk, clean, buildJkIndex, sessionForJk, sessionIdSet, rollupBySession, sessionGrid, sessionHealth };
