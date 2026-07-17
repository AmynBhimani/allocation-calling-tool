// Per-session duty roster engine (Phase 3). Pure — no I/O — so the messy bits are unit-testable.
//
// The templates go out to thirteen process areas and come back filled by volunteers, so the parsing
// is deliberately LIBERAL and the result is always shown back before anything is written: it is far
// better to accept "7:30 AM" and display what we understood than to reject a team's file at 11pm.
// Anything genuinely unreadable is reported per row (file, sheet, row number) — never guessed at.
//
// Two outputs, kept separate on purpose:
//   • roster      — {session: {area: [{duty, min, leads, checkIn}]}}  the per-session requirement
//   • newDuties   — duties typed at the bottom of a template, to be added to the MASTER catalog
// "Remove from this session" only drops the duty from THAT session's roster; the master catalog and
// the other sessions are untouched.

const { clean, norm, dupOf, findDuty } = require("../shared/duties");

const pad2 = (n) => (n < 10 ? "0" : "") + n;

// TRUE-ish marks: X, x, Yes, Y, 1, TRUE, ✓. Blank / No / 0 = keep.
function parseRemove(v) {
  const s = norm(v);
  if (!s) return false;
  return ["x", "yes", "y", "1", "true", "\u2713", "\u2714", "remove"].includes(s);
}

// A whole non-negative count. Blank -> null (not supplied). Junk -> error.
function parseCount(v) {
  if (v == null || clean(v) === "") return { value: null };
  const n = Number(clean(v));
  if (!Number.isFinite(n) || n < 0) return { value: null, error: `“${clean(v)}” isn't a number` };
  if (!Number.isInteger(n)) return { value: Math.round(n), warn: `rounded ${clean(v)} to ${Math.round(n)}` };
  return { value: n };
}

// Check-in time -> "HH:MM" 24-hour. Accepts what people actually type, plus what Excel actually stores:
//   "7:30" "07:30" "7:30 AM" "7.30" "0730" "7" ... and Excel's own time value (0.3125 = 07:30).
function parseCheckIn(v) {
  if (v == null || clean(v) === "") return { value: null };
  // Excel time-formatted cells arrive as a fraction of a day.
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 0 && v < 1) {
      let mins = Math.round(v * 24 * 60);
      if (mins >= 1440) mins = 1439;
      return { value: pad2(Math.floor(mins / 60)) + ":" + pad2(mins % 60) };
    }
    if (Number.isInteger(v) && v >= 0 && v <= 24) return { value: pad2(v === 24 ? 0 : v) + ":00" };   // "7" -> 07:00
    if (Number.isInteger(v) && v >= 100 && v <= 2359) return hhmm(Math.floor(v / 100), v % 100, null, v);
    return { value: null, error: `couldn't read “${v}” as a time` };
  }
  let s = norm(v).replace(/\s+/g, " ");
  let ampm = null;
  const ap = s.match(/(a\.?m\.?|p\.?m\.?)$/);
  if (ap) { ampm = ap[1][0]; s = s.slice(0, ap.index).trim(); }
  s = s.replace(/[.\u2236]/g, ":");                       // 7.30 -> 7:30
  let m;
  if ((m = s.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/))) return hhmm(+m[1], +m[2], ampm, v);
  if ((m = s.match(/^(\d{3,4})$/))) { const n = +m[1]; return hhmm(Math.floor(n / 100), n % 100, ampm, v); }
  if ((m = s.match(/^(\d{1,2})$/))) return hhmm(+m[1], 0, ampm, v);
  return { value: null, error: `couldn't read “${clean(v)}” as a time` };
}
function hhmm(h, mi, ampm, raw) {
  if (ampm === "p" && h < 12) h += 12;
  if (ampm === "a" && h === 12) h = 0;
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) {
    return { value: null, error: `“${clean(raw)}” isn't a valid time` };
  }
  return { value: pad2(h) + ":" + pad2(mi) };
}

// files: [{ fileName, area, entries: [{ sessionId, sheet, row, duty, description, remove, min, leads, checkIn }] }]
// catalog: duties.json   sessions: [{id, name}]
// opts.current: the COMMITTED roster {session: {area: [rows]}} — the base an import merges onto.
// opts.holders: (session, area, duty) -> [{user_id, name, state}] — who is already doing that duty.
//
// MERGE, not replace. A template goes out pre-filled with every duty in the area's master catalog, so
// a file that replaced its cell wholesale would silently drop anything not in the catalog and quietly
// resurrect, at min 0, every duty an area had dropped. Instead: a row is only applied if it was
// actually filled in, and a duty only leaves a session when someone explicitly marks Remove. That is
// what makes re-uploading the same template safe, and lets an area send back only what changed.
function planRoster(files, catalog, sessions, opts) {
  opts = opts || {};
  const areasAllowed = opts.areas || [];
  const current = (opts.current && typeof opts.current === "object") ? opts.current : {};
  const holdersOf = typeof opts.holders === "function" ? opts.holders : () => [];
  const sessById = new Map((sessions || []).map(s => [String(s.id), s]));
  const roster = {};                 // sessionId -> area -> [rows]  (the MERGED result for touched cells)
  const newDuties = [];              // {area, name, description} to add to the master catalog
  const problems = [];               // rows we could not use
  const warnings = [];               // rows we used, but the operator should see
  const removed = [];                // duty dropped from that session
  const blocked = [];                // Remove refused: someone is already doing it
  const untouched = [];              // rows left exactly as they were (blank = "I didn't fill this in")

  // Start every touched cell from what is already committed, so anything the file doesn't mention
  // survives untouched.
  const cellFor = (sid, area) => {
    const bySession = roster[sid] || (roster[sid] = {});
    if (!bySession[area]) {
      const prior = ((current[sid] || {})[area] || []);
      bySession[area] = prior.map(r => ({ duty: clean(r.duty), min: Number(r.min) || 0,
        leads: Number(r.leads) || 0, checkIn: clean(r.checkIn) }));
    }
    return bySession[area];
  };
  const indexIn = (cell, name) => cell.findIndex(r => norm(r.duty) === norm(name));

  // The master catalog and the per-session roster are separate outputs, so a duty name typed into the
  // blank rows goes into the catalog whether or not the team gave it a minimum. Returns true if the
  // duty was already known.
  function captureNewDuty(area, name, description, whereStr) {
    if (findDuty(catalog, area, name)) return true;
    const already = newDuties.find(x => clean(x.area) === area && norm(x.name) === norm(name));
    if (!already) {
      const d = { area, name, description: clean(description) };
      const dup = dupOf(catalog, d);                                  // same rule the Duties screen uses
      if (dup) warnings.push({ where: whereStr, duty: name, issue: `looks like a duplicate of the existing duty “${dup.match.name}” (same ${dup.field}) — it will still be added as new` });
      newDuties.push(d); counts.added++;
    }
    return false;
  }
  const seen = new Set();            // sessionId|area|dutyname — catches the same duty twice in a sheet
  const counts = { files: 0, sheets: 0, rows: 0, kept: 0, removed: 0, added: 0, skipped: 0, untouched: 0, blocked: 0 };
  const sessionsTouched = new Set();
  const areasTouched = new Set();

  for (const f of (files || [])) {
    counts.files++;
    const area = clean(f.area);
    const where = (e) => `${clean(f.fileName) || "file"} · ${clean(e.sheet) || "sheet"} · row ${e.row || "?"}`;
    if (!area || !areasAllowed.includes(area)) {
      problems.push({ where: clean(f.fileName) || "file", issue: `unrecognized process area “${area || "(blank)"}” — is this a generated template?` });
      continue;
    }
    areasTouched.add(area);
    const sheets = new Set();
    for (const e of (f.entries || [])) {
      counts.rows++;
      sheets.add(e.sheet);
      const name = clean(e.duty);
      if (!name) { counts.skipped++; continue; }                       // blank row: the spare rows at the bottom
      const sid = String(e.sessionId || "");
      if (!sessById.has(sid)) {
        problems.push({ where: where(e), duty: name, issue: `this sheet isn't one of the current sessions (id “${sid}”) — regenerate the template` });
        continue;
      }
      sessionsTouched.add(sid);
      const key = sid + "|" + norm(area) + "|" + norm(name);
      if (seen.has(key)) {
        problems.push({ where: where(e), duty: name, issue: "listed twice for this session — keeping the first" });
        continue;
      }
      seen.add(key);

      const sessionName = (sessById.get(sid) || {}).name || sid;

      if (parseRemove(e.remove)) {
        // HARD GUARD. A duty someone is already doing cannot be dropped here: the assignment has to be
        // backed out in iVolunteer first, and Phase 4a is gap-fill — it never reclaims a duty someone
        // is holding — so removing it would leave them holding a duty that no longer exists, forever.
        // No declaration overrides this, by decision: there is no version of this the app should do.
        const who = holdersOf(sid, area, name) || [];
        if (who.length) {
          blocked.push({ session: sid, sessionName, area, duty: name, where: where(e),
            holders: who.slice(0, 25).map(h => ({ user_id: h.user_id, name: h.name, state: h.state || "" })),
            holderCount: who.length });
          continue;
        }
        counts.removed++;
        removed.push({ session: sid, sessionName, area, duty: name });
        const cell = cellFor(sid, area);
        const at = indexIn(cell, name);
        if (at >= 0) cell.splice(at, 1);
        continue;                                                       // dropped from THIS session only
      }

      // A pre-filled row the team never filled in is not an instruction. Blank means "I didn't touch
      // this", NOT "roster it at 0" — an explicit 0 is a real floor (a low-priority duty to be filled
      // once everything else is looked after), and only a typed 0 should say so.
      const untouchedRow = clean(e.min) === "" && clean(e.leads) === "" && clean(e.checkIn) === "";
      if (untouchedRow) {
        counts.untouched++;
        const cell = cellFor(sid, area);
        const already = indexIn(cell, name) >= 0;
        untouched.push({ session: sid, sessionName, area, duty: name, inRoster: already });
        // The name still goes to the CATALOG — blank values mean "not rostered for this session",
        // not "this duty doesn't exist". Only the roster half of the row is left alone.
        const known = captureNewDuty(area, name, e.description, where(e));
        if (!known) {
          warnings.push({ where: where(e), duty: name,
            issue: "added to the catalog, but not rostered for this session \u2014 no minimum, leads or check-in was given" });
        }
        continue;
      }

      const min = parseCount(e.min);
      const leads = parseCount(e.leads);
      const t = parseCheckIn(e.checkIn);
      if (min.error) problems.push({ where: where(e), duty: name, issue: `Minimum required: ${min.error}` });
      if (leads.error) problems.push({ where: where(e), duty: name, issue: `Leads required: ${leads.error}` });
      if (t.error) problems.push({ where: where(e), duty: name, issue: `Check-in time: ${t.error}` });
      if (min.error || leads.error || t.error) continue;                // don't half-write a row
      if (min.warn) warnings.push({ where: where(e), duty: name, issue: `Minimum required: ${min.warn}` });
      if (leads.warn) warnings.push({ where: where(e), duty: name, issue: `Leads required: ${leads.warn}` });
      // Reachable only when leads or check-in WAS filled in — a wholly blank row is untouched above.
      if (min.value == null) warnings.push({ where: where(e), duty: name, issue: "no minimum given — recorded as 0" });

      const known = captureNewDuty(area, name, e.description, where(e));

      const cell = cellFor(sid, area);
      const at = indexIn(cell, name);
      const row = { duty: name, min: min.value == null ? 0 : min.value,
        leads: leads.value == null ? 0 : leads.value, checkIn: t.value || "", isNew: !known };
      if (at >= 0) cell[at] = row; else cell.push(row);                  // upsert onto the committed cell
      counts.kept++;
    }
    counts.sheets += sheets.size;
  }

  for (const sid of Object.keys(roster)) {
    for (const a of Object.keys(roster[sid])) roster[sid][a].sort((x, y) => x.duty.localeCompare(y.duty));
  }
  const summary = [...sessionsTouched].map(sid => {
    const s = sessById.get(sid) || { id: sid, name: sid };
    const byArea = roster[sid] || {};
    const areas = Object.keys(byArea).sort();
    return {
      id: sid, name: s.name,
      areas: areas.map(a => ({
        area: a, duties: byArea[a].length,
        minTotal: byArea[a].reduce((n, r) => n + r.min, 0),
        leadsTotal: byArea[a].reduce((n, r) => n + r.leads, 0),
        noTime: byArea[a].filter(r => !r.checkIn).length,
        rows: byArea[a],
      })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  counts.blocked = blocked.length;
  return { roster, newDuties, problems, warnings, removed, blocked, untouched, counts, summary,
    areasTouched: [...areasTouched].sort(), sessionsTouched: [...sessionsTouched] };
}

module.exports = { planRoster, parseCheckIn, parseCount, parseRemove };
