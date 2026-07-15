// Session allocation (Phase 2) — pure function over stored volunteer records. No I/O.
// Deterministic: a person's session follows their ceremony Jamatkhana, so there is no randomness,
// no seed and no percentages here. Preview and commit compute the identical plan.
//
// Model (per Didar):
//   1. Eligible = ACCEPTED volunteers (shared isAcceptedVolunteer: iVol-ready, or last call outcome
//      Accepted; Leadership excluded) who hold a confirmed final_area. Everyone else is reported,
//      never placed — an un-called or un-accepted person has not agreed to serve yet.
//   2. Each session carries a Jamatkhana list (set on the Events screen). A volunteer whose
//      ceremony_jk is in a session's list is a PRIMARY member of that session -> basis "session".
//   3. Support volunteers (people pulled into a session they don't belong to by JK) are Phase 4 —
//      this pass never invents them, and never touches an existing basis "support" row.
//   4. A JK claimed by 2+ sessions is a mapping error: it is FLAGGED and its people are left
//      unplaced rather than silently placed in an arbitrary one of them.
//
// Re-run safety: the plan is a SYNC, not an append. Rows are keyed by event, so re-running after a
// JK mapping change converges — a person's stale primary row for this Didar's sessions is removed
// when they no longer map to it. Only rows with basis "session" for sessions under THIS Didar are
// ever touched; Didar rows (basis "pending"), support rows and other Didars' rows are left alone.
// A stale row that already carries an assigned duty is kept and flagged, never silently dropped.

// The JK -> session mapping lives in shared/sessions so the dashboard reports with the exact same
// mapping this allocates with.
const { normJk, clean, buildJkIndex } = require("../shared/sessions");

// Sync one person's session rows to their target session. Pure; returns the new row array + actions.
// scope = Set of session ids under the Didar being run (the only rows this pass may manage).
function syncRows(v, targetId, scope) {
  const rows = Array.isArray(v.event_assignments) ? v.event_assignments.slice() : [];
  const out = [];
  const actions = [];
  let found = false;
  for (const r of rows) {
    if (!r || r.event == null) { out.push(r); continue; }
    const managed = scope.has(String(r.event)) && r.basis === "session";
    if (!managed) { out.push(r); continue; }            // Didar / support / other-Didar rows: untouched
    if (targetId != null && String(r.event) === String(targetId)) {
      found = true;
      if (r.area !== v.final_area) { out.push({ ...r, area: v.final_area }); actions.push("refresh"); }
      else { out.push(r); actions.push("keep"); }
      continue;
    }
    // They no longer map to this session (a JK mapping changed, or their JK did).
    if (clean(r.duty)) { out.push(r); actions.push("stale_with_duty"); }   // real work — keep + flag
    else actions.push("remove");
  }
  if (targetId != null && !found) {
    out.push({ event: targetId, area: v.final_area, candidate_duties: [], duty: "", basis: "session", state: "pending" });
    actions.push("add");
  }
  return { rows: out, actions };
}

// records: the Didar's regions' volunteers. sessions: active sessions under the Didar.
// isAccepted: injected so the engine stays pure and the definition has one home (shared/rollup).
function planSessions(records, sessions, cfg) {
  cfg = cfg || {};
  const isAccepted = cfg.isAccepted || (() => false);
  const jkIndex = buildJkIndex(sessions);
  const scope = new Set((sessions || []).map(s => String(s.id)));
  const byId = {}; for (const s of (sessions || [])) byId[s.id] = s;

  // Jamatkhanas claimed by more than one session — the mapping error we flag rather than guess at.
  const duplicateJks = [];
  for (const [, list] of jkIndex) {
    if (list.length >= 2) duplicateJks.push({ jk: list[0].label, sessions: list.map(x => ({ id: x.id, name: x.name })) });
  }
  const dupKeys = new Set();
  for (const [k, list] of jkIndex) if (list.length >= 2) dupKeys.add(k);

  const counts = {
    scanned: records.length, accepted: 0, notAccepted: 0,
    placed: 0, noJk: 0, unmappedJk: 0, duplicateJk: 0, noArea: 0,
    added: 0, kept: 0, refreshed: 0, removed: 0, staleWithDuty: 0, removedNotAccepted: 0,
  };
  const matrix = {};                       // sessionId -> { area -> n }
  for (const s of (sessions || [])) matrix[s.id] = {};
  const unmapped = new Map();              // jk label -> count of accepted people stranded there
  const noJkList = [], noAreaList = [], staleList = [];
  const changes = [];                      // { user_id, region, rows } for the commit
  const decisions = [];

  const changedBy = (actions) => actions.some(a => a === "add" || a === "remove" || a === "refresh");

  for (const v of records) {
    if (!isAccepted(v)) {
      counts.notAccepted++;
      // Someone who was placed and has SINCE been reopened or declined is no longer accepted, so they
      // must come off the roster — otherwise a withdrawal would silently leave them in a session
      // forever. Same rule as everywhere: a row already carrying an assigned duty is kept + flagged.
      const { rows, actions } = syncRows(v, null, scope);
      if (actions.length) {
        tally(actions, counts, v, staleList);
        counts.removedNotAccepted += actions.filter(a => a === "remove").length;
        if (changedBy(actions)) changes.push({ user_id: v.user_id, region: v.region, rows });
      }
      continue;
    }
    counts.accepted++;

    const area = clean(v.final_area);
    if (!area) {                            // accepted but no confirmed area — nothing to carry
      counts.noArea++;
      if (noAreaList.length < 300) noAreaList.push({ user_id: v.user_id, name: nameOf(v), region: v.region, jk: clean(v.ceremony_jk) });
      continue;
    }
    const jkRaw = clean(v.ceremony_jk);
    const k = normJk(jkRaw);
    if (!k) {
      counts.noJk++;
      if (noJkList.length < 300) noJkList.push({ user_id: v.user_id, name: nameOf(v), region: v.region, area });
      continue;
    }
    if (dupKeys.has(k)) {                   // JK in 2+ sessions: flagged, deliberately not placed
      counts.duplicateJk++;
      continue;
    }
    const hit = jkIndex.get(k);
    const targetId = hit && hit.length === 1 ? hit[0].id : null;
    if (!targetId) {                        // JK isn't on any session's list yet
      counts.unmappedJk++;
      unmapped.set(jkRaw, (unmapped.get(jkRaw) || 0) + 1);
      // Still sync: if they used to map somewhere under this Didar, that stale row must go.
      const { rows, actions } = syncRows(v, null, scope);
      tally(actions, counts, v, staleList);
      if (changedBy(actions)) changes.push({ user_id: v.user_id, region: v.region, rows });
      decisions.push({ user_id: v.user_id, region: v.region, session: null, area, reason: "Jamatkhana not mapped to a session" });
      continue;
    }

    const { rows, actions } = syncRows(v, targetId, scope);
    tally(actions, counts, v, staleList);
    if (changedBy(actions)) changes.push({ user_id: v.user_id, region: v.region, rows });
    counts.placed++;
    matrix[targetId][area] = (matrix[targetId][area] || 0) + 1;
    decisions.push({ user_id: v.user_id, region: v.region, session: targetId, area, reason: null });
  }

  const sessionRows = (sessions || []).map(s => {
    const m = matrix[s.id] || {};
    const total = Object.keys(m).reduce((a, k2) => a + m[k2], 0);
    return { id: s.id, name: s.name, jkCount: (s.jamatkhanas || []).length, total, byArea: m };
  });
  const areasPresent = [...new Set(sessionRows.flatMap(r => Object.keys(r.byArea)))].sort();

  return {
    counts, sessions: sessionRows, areasPresent,
    duplicateJks,
    unmappedJks: [...unmapped.entries()].map(([jk, n]) => ({ jk, accepted: n })).sort((a, b) => b.accepted - a.accepted),
    noJkList, noAreaList, staleList: staleList.slice(0, 300),
    changes, decisions,
  };
}

function nameOf(v) { return ((v.first || "") + " " + (v.last || "")).trim(); }
function tally(actions, counts, v, staleList) {
  for (const a of actions) {
    if (a === "add") counts.added++;
    else if (a === "keep") counts.kept++;
    else if (a === "refresh") counts.refreshed++;
    else if (a === "remove") counts.removed++;
    else if (a === "stale_with_duty") {
      counts.staleWithDuty++;
      if (staleList.length < 300) staleList.push({ user_id: v.user_id, name: nameOf(v), region: v.region });
    }
  }
}

module.exports = { planSessions, syncRows, buildJkIndex, normJk };   // buildJkIndex/normJk re-exported from shared/sessions
