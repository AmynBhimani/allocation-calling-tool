// Recategorise duties from one area to another — the DA migration. Pure: no I/O, so every branch of
// "who moves and who stays" is unit-testable. The endpoint reads the three blobs, calls this to get a
// plan, shows it, and on commit applies exactly what the plan describes.
//
// WHY THIS EXISTS. The Diverse Abilities duties were catalogued under Reception & Hospitality, so the
// AREA allocation placed people interested in them into Hospitality. Splitting DA Support into its own
// area means the duties move — and the people connected to them have to follow, or DA Support has
// nobody for its own duty allocation to place.
//
// A duty's NAME does not change when it moves, so every candidate_duties and assigned_duty that names
// it stays valid — it just points into the new area now. Nothing about a person's duty references is
// rewritten; what moves is their AREA (final_area AND their session row's area, which must agree or
// the person shows on one screen and vanishes from the other).
//
// WHO MOVES — decided with Amyn, 17 July:
//   • Source area only. Someone allocated to Registration who merely also fancied a DA duty was put in
//     Registration for a reason; a secondary interest does not uproot a settled allocation.
//   • HELD (their session duty is a moving duty, or a caller assigned them one) -> move, keep the duty.
//   • INTEREST with nothing to protect (no duty, or their duty is itself moving) -> move; DA Support's
//     allocation will place them.
//   • INTEREST but allocated to a DIFFERENT, non-moving duty -> LEAVE. A real assignment beats a
//     secondary interest, and their acceptance is not a thing to undo. Reported, not moved.
//   • ASSIGNED IN IVOL on a moving duty -> the duty CANNOT move: Better Impact holds that shift, and
//     splitting the area from the shift is exactly what the iVol lock prevents. Blocks that ONE duty
//     (others in the batch still move); back the person out in BI, then re-run.
const clean = (s) => String(s == null ? "" : s).trim();
const norm = (s) => clean(s).toLowerCase();

// A volunteer has at most one session row (region fixes the Didar, JK fixes the session), so "their
// duty" is unambiguous. Mirrors theSessionRow in the engine; duplicated here to keep this module
// free of an engine dependency for a one-line find.
const theSessionRow = (v) => (Array.isArray(v.event_assignments) ? v.event_assignments : [])
  .find(r => r && r.basis === "session") || null;

const requestsOf = (v) => [...new Set((Array.isArray(v.event_assignments) ? v.event_assignments : [])
  .flatMap(a => (Array.isArray(a && a.candidate_duties) ? a.candidate_duties : []))
  .map(d => clean(d)).filter(Boolean))];

// planMigration(volunteers, catalog, roster, opts)
//   opts.from     source area (required)
//   opts.to       target area (required)
//   opts.duties   duty names to move (required, non-empty)
//   opts.lockedStates  which duty states are the iVol wall (default ["entered"])
//   opts.sessionName(id) -> label, for readable output (optional)
function planMigration(volunteers, catalog, roster, opts) {
  const from = clean(opts.from), to = clean(opts.to);
  const moveNames = new Set((opts.duties || []).map(norm).filter(Boolean));
  // norm(name) -> the name exactly as the operator typed it, so anything echoed back (a typo, a
  // blocked duty) reads the way they wrote it rather than lower-cased.
  const asTyped = new Map();
  for (const d of (opts.duties || [])) { const n = norm(d); if (n && !asTyped.has(n)) asTyped.set(n, clean(d)); }
  const LOCKED = new Set((opts.lockedStates || ["entered"]).map(norm));
  const sessName = opts.sessionName || ((id) => id);
  const isMoving = (name) => moveNames.has(norm(name));

  const errors = [];
  if (!from) errors.push("No source area given.");
  if (!to) errors.push("No target area given.");
  if (from && to && from === to) errors.push("Source and target areas are the same.");
  if (!moveNames.size) errors.push("No duties selected to move.");

  // ---- the duties themselves: catalog + every roster row ----------------------------------------
  const cat = Array.isArray(catalog) ? catalog : [];
  const sessions = (roster && roster.sessions) || {};

  // Which selected duties actually exist in the source area's catalog. A name that isn't there is
  // reported, never invented.
  const catalogHas = new Set(cat.filter(d => clean(d.area) === from).map(d => norm(d.name)));
  const missing = [...moveNames].filter(n => !catalogHas.has(n));
  // A name already present in the TARGET would collide on move — flag rather than duplicate.
  const targetHas = new Set(cat.filter(d => clean(d.area) === to).map(d => norm(d.name)));
  const collisions = [...moveNames].filter(n => targetHas.has(n));

  // Who is doing each moving duty, per session, so an iVol lock on any of them can block that duty.
  // Blocking is per-DUTY: one locked holder freezes that duty's move, not the whole batch.
  const lockedByDuty = new Map();       // norm(duty) -> [{name, session, sessionName}]
  const holdersByDuty = new Map();      // norm(duty) -> count (for the preview)
  for (const v of (volunteers || [])) {
    const sr = theSessionRow(v);
    if (!sr) continue;
    const d = clean(sr.duty);
    if (!d || !isMoving(d)) continue;
    holdersByDuty.set(norm(d), (holdersByDuty.get(norm(d)) || 0) + 1);
    if (LOCKED.has(norm(sr.state))) {
      if (!lockedByDuty.has(norm(d))) lockedByDuty.set(norm(d), []);
      lockedByDuty.get(norm(d)).push({ user_id: v.user_id,
        name: ((v.first || "") + " " + (v.last || "")).trim() || String(v.user_id),
        session: clean(sr.event), sessionName: sessName(clean(sr.event)) });
    }
  }

  // A duty moves unless something stops it: not in the source catalog, would collide in the target,
  // or somebody is assigned to it in iVolunteer.
  const blocked = [];       // duties that cannot move, with the reason
  const willMove = [];      // duties that will move
  for (const n of moveNames) {
    const name = (cat.find(d => clean(d.area) === from && norm(d.name) === n) || {}).name
      || [...(volunteers || [])].map(v => clean((theSessionRow(v) || {}).duty)).find(d => norm(d) === n)
      || asTyped.get(n) || n;
    if (missing.includes(n)) { blocked.push({ duty: name, reason: "not_in_source",
      detail: `not a duty in ${from}` }); continue; }
    if (collisions.includes(n)) { blocked.push({ duty: name, reason: "collision",
      detail: `${to} already has a duty called \u201c${name}\u201d` }); continue; }
    if (lockedByDuty.has(n)) { blocked.push({ duty: name, reason: "in_ivol",
      holders: lockedByDuty.get(n), holderCount: lockedByDuty.get(n).length,
      detail: `assigned in iVolunteer \u2014 back the assignment out in Better Impact first` }); continue; }
    willMove.push(name);
  }
  const moving = new Set(willMove.map(norm));       // the duties that ACTUALLY move (blocked ones drop out)
  const willMoveDuty = (name) => moving.has(norm(name));

  // The roster edits: pull each moving duty's row out of the source cell and drop it into the target,
  // per session. Recorded as instructions the commit replays, so preview and commit cannot diverge.
  const rosterMoves = [];   // {session, sessionName, duty, row}
  for (const sid of Object.keys(sessions)) {
    const srcCell = (sessions[sid] || {})[from] || [];
    for (const r of srcCell) {
      if (willMoveDuty(r.duty)) rosterMoves.push({ session: sid, sessionName: sessName(sid),
        duty: clean(r.duty), row: r });
    }
  }

  // ---- the people --------------------------------------------------------------------------------
  const movePeople = [];    // {user_id, name, region, keepsDuty}
  const leftBehind = [];    // interested but committed to a non-moving duty — reported, not moved
  const strandedByBlock = [];  // would have moved, but their duty is blocked from moving
  let biCorrections = 0;

  for (const v of (volunteers || [])) {
    if (clean(v.final_area) !== from) continue;         // SOURCE AREA ONLY
    const sr = theSessionRow(v);
    const sessionDuty = sr ? clean(sr.duty) : "";
    const assigned = clean(v.assigned_duty);

    // Their connection to the SELECTED duties, before blocking is considered.
    const heldOnSelected = (sessionDuty && isMoving(sessionDuty)) || (assigned && isMoving(assigned));
    const interested = requestsOf(v).some(isMoving);
    const otherDuty = sessionDuty && !isMoving(sessionDuty);   // a real, non-moving duty they hold

    if (!heldOnSelected && !interested) continue;      // not connected to this migration at all

    // Decision 2: interest alone does not pull someone off a duty they were actually given.
    if (!heldOnSelected && interested && otherDuty) {
      leftBehind.push({ user_id: v.user_id,
        name: ((v.first || "") + " " + (v.last || "")).trim() || String(v.user_id),
        region: v.region, heldDuty: sessionDuty });
      continue;
    }

    // They qualify to move. But if the specific duty tying them here is BLOCKED (iVol/collision/
    // missing), the move can't happen — surface them so nobody silently stays behind.
    const tie = (sessionDuty && isMoving(sessionDuty)) ? sessionDuty
      : (assigned && isMoving(assigned)) ? assigned
      : requestsOf(v).find(isMoving);
    if (heldOnSelected && !willMoveDuty(tie)) {
      strandedByBlock.push({ user_id: v.user_id,
        name: ((v.first || "") + " " + (v.last || "")).trim() || String(v.user_id),
        region: v.region, duty: tie });
      continue;
    }
    // Interest-only mover whose interest is entirely in blocked duties: nothing to move them for.
    if (!heldOnSelected && interested && !requestsOf(v).some(willMoveDuty)) continue;

    // keepsDuty: if their session duty is a moving duty, it travels with them into the target and they
    // stay on it. Otherwise (interest-only, no duty) there is nothing to keep — DA Support's allocation
    // places them.
    const keepsDuty = !!(sessionDuty && willMoveDuty(sessionDuty));
    // Already in Better Impact (registration entered) -> their committee there is now wrong and the
    // iVol team must fix it. Not yet in BI -> they'll be entered fresh with the right area, no flag.
    const needsBi = !!v.ivol_entered;
    if (needsBi) biCorrections++;
    movePeople.push({ user_id: v.user_id,
      name: ((v.first || "") + " " + (v.last || "")).trim() || String(v.user_id),
      region: v.region, keepsDuty, duty: keepsDuty ? sessionDuty : "", biCorrection: needsBi });
  }

  return {
    from, to, errors,
    duties: { requested: [...moveNames], willMove, blocked, missing, collisions },
    rosterMoves,
    people: { move: movePeople, leftBehind, strandedByBlock },
    counts: {
      dutiesMoving: willMove.length, dutiesBlocked: blocked.length,
      rosterRows: rosterMoves.length,
      peopleMoving: movePeople.length, peopleKeepingDuty: movePeople.filter(p => p.keepsDuty).length,
      leftBehind: leftBehind.length, stranded: strandedByBlock.length,
      biCorrections,
    },
  };
}

module.exports = { planMigration, theSessionRow, requestsOf };
