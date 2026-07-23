// Per-session duty roster engine (Phase 3). Pure — no I/O — so the messy bits are unit-testable.
//
// The templates go out to thirteen process areas and come back filled by volunteers, so the parsing
// is deliberately LIBERAL and the result is always shown back before anything is written: it is far
// better to accept "7:30 AM" and display what we understood than to reject a team's file at 11pm.
// Anything genuinely unreadable is reported per row (file, sheet, row number) — never guessed at.
//
// Two outputs, kept separate on purpose:
//   • roster      — {session: {area: [{duty, min, leads, minAge, checkIn}]}}  the per-session requirement
//   • newDuties   — duties typed at the bottom of a template, to be added to the MASTER catalog
// "Remove from this session" only drops the duty from THAT session's roster; the master catalog and
// the other sessions are untouched.

const { clean, norm, dupOf, findDuty } = require("../shared/duties");
// The ENGINE owns lead-duty derivation; the import only has to agree with it about the reserved name
// and about what a Leads count implies. Importing rather than re-deriving makes drift impossible.
const { isLeadName, leadNameFor, expandRoster, LEAD_PREFIX, LOCKED_STATES } = require("../dutyalloc/dutyalloc");

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

  // REPLACE, not merge: a cell the upload addresses is rebuilt from ONLY the rows it fills in. Whatever
  // the committed roster had that this upload doesn't fill is a removal, reconciled after all rows are
  // read (see the pass at the end). touchedCells records every cell the file speaks to — a filled row,
  // a blank row, or a Remove all count as "addressed", so its removals get computed.
  const touchedCells = new Set();
  const cellFor = (sid, area) => {
    touchedCells.add(sid + "|" + area);
    const bySession = roster[sid] || (roster[sid] = {});
    if (!bySession[area]) bySession[area] = [];
    return bySession[area];
  };
  const indexIn = (cell, name) => cell.findIndex(r => norm(r.duty) === norm(name));

  // Everyone a removal would strand: the duty's own holders PLUS the holders of the lead duty it
  // derives, because removing the parent removes the lead with it.
  const holdersFor = (sid, area, name) => {
    const own = (holdersOf(sid, area, name) || []).map(h =>
      ({ user_id: h.user_id, region: h.region, name: h.name, state: clean(h.state), duty: clean(name) }));
    const leads = (holdersOf(sid, area, leadNameFor(name)) || []).map(h =>
      ({ user_id: h.user_id, region: h.region, name: h.name, state: clean(h.state), duty: leadNameFor(name) }));
    return own.concat(leads);
  };

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
  const counts = { files: 0, sheets: 0, rows: 0, kept: 0, removed: 0, cleared: 0, added: 0,
    skipped: 0, untouched: 0, blocked: 0 };
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

      // "Lead - X" is DERIVED from a duty's Leads required count, never typed. A real duty by that
      // name would collide with the one the engine generates, so the name is reserved outright.
      if (isLeadName(name)) {
        counts.skipped++;
        problems.push({ where: where(e), duty: name,
          issue: `\u201c${LEAD_PREFIX}\u2026\u201d is reserved \u2014 lead duties are created automatically from the ` +
                 `Leads required column. Put the number of leads on the duty itself rather than adding a row for them.` });
        continue;
      }

      if (parseRemove(e.remove)) {
        // Under replace, an explicit Remove and a blank row mean the same thing: this duty is not in
        // the uploaded roster for this cell. Just mark the cell addressed and drop the row; if the
        // committed roster had the duty, the reconciliation pass at the end removes it, guards iVol,
        // and gathers who to move.
        cellFor(sid, area);
        continue;                                                       // dropped from THIS session only
      }

      // A pre-filled row the team never filled in is not an instruction. Blank means "I didn't touch
      // this", NOT "roster it at 0" — an explicit 0 is a real floor (a low-priority duty to be filled
      // once everything else is looked after), and only a typed 0 should say so.
      const untouchedRow = clean(e.min) === "" && clean(e.leads) === ""
        && clean(e.minAge) === "" && clean(e.checkIn) === "";
      if (untouchedRow) {
        // A blank row rosters NOTHING (replace, not merge): the duty is simply absent from the uploaded
        // roster for this cell. Mark the cell addressed so the pass below removes the duty (and moves
        // anyone on it) if the committed roster had it. The name still reaches the CATALOG — blank means
        // "not rostered here", not "this duty doesn't exist".
        counts.untouched++;
        cellFor(sid, area);
        untouched.push({ session: sid, sessionName, area, duty: name });
        const known = captureNewDuty(area, name, e.description, where(e));
        if (!known) {
          warnings.push({ where: where(e), duty: name,
            issue: "added to the catalog, but not rostered for this session \u2014 no minimum, leads or check-in was given" });
        }
        continue;
      }

      const min = parseCount(e.min);
      const leads = parseCount(e.leads);
      const minAge = parseCount(e.minAge);
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

      // Leads dropping to 0 (which deletes the derived "Lead - X") and reductions in min are handled by
      // the reconciliation pass below, against the COMMITTED roster — not against this fresh cell, which
      // no longer carries the prior values.
      const row = { duty: name, min: min.value == null ? 0 : min.value,
        leads: leads.value == null ? 0 : leads.value,
        // Blank age = no gate, and so does 0 — stored as null either way, so nothing downstream has
        // to decide whether "minAge: 0" means "no limit" or "everyone qualifies".
        minAge: minAge.value ? minAge.value : null,
        checkIn: t.value || "", isNew: !known };
      if (at >= 0) cell[at] = row; else cell.push(row);
      counts.kept++;
    }
    counts.sheets += sheets.size;
  }

  // ---- REPLACE reconciliation ----
  // For every cell the upload addressed, compare the committed roster to what the upload rostered.
  // Anything the upload left out is a removal: the people on it (and on the lead duty it derives) go
  // back to unassigned-in-area and are flagged to reassign. The one wall stays: a duty someone is
  // ENTERED for in iVolunteer can't be yanked — Better Impact holds that shift — so it is kept exactly
  // as committed and reported. A held holder keeps the WHOLE duty (its non-iVol holders included),
  // which is the same all-or-nothing the old Remove guard applied.
  for (const key of touchedCells) {
    const cut = key.indexOf("|"); const sid = key.slice(0, cut), area = key.slice(cut + 1);
    const sessionName = (sessById.get(sid) || {}).name || sid;
    const newCell = (roster[sid] || {})[area] || [];
    for (const pr of ((current[sid] || {})[area] || [])) {
      const pdName = clean(pr.duty); if (!pdName) continue;
      const nd = newCell.find(r => norm(r.duty) === norm(pdName));
      if (!nd) {
        // the base duty is gone entirely — strands its own holders AND its lead's holders
        const who = holdersFor(sid, area, pdName);
        const inIvol = who.filter(h => LOCKED_STATES.includes(clean(h.state)));
        if (inIvol.length) {
          newCell.push({ duty: pdName, min: Number(pr.min) || 0, leads: Number(pr.leads) || 0,
            minAge: Number(pr.minAge) > 0 ? Number(pr.minAge) : null, checkIn: clean(pr.checkIn), isNew: false });
          blocked.push({ session: sid, sessionName, area, duty: pdName, reason: "in_ivol",
            holders: inIvol.slice(0, 25), holderCount: inIvol.length });
        } else {
          counts.removed++; counts.cleared += who.length;
          removed.push({ session: sid, sessionName, area, duty: pdName, clearing: who });
        }
      } else {
        // the base duty stays, but leads falling to 0 deletes the "Lead - X" it derived
        const priorLeads = Number(pr.leads) || 0, nextLeads = Number(nd.leads) || 0;
        if (priorLeads > 0 && nextLeads === 0) {
          const leadName = leadNameFor(pdName);
          const who = (holdersOf(sid, area, leadName) || []).map(h =>
            ({ user_id: h.user_id, region: h.region, name: h.name, state: clean(h.state), duty: leadName }));
          const inIvol = who.filter(h => LOCKED_STATES.includes(clean(h.state)));
          if (inIvol.length) {
            nd.leads = priorLeads;                     // held in iVol — keep the leads it derives
            blocked.push({ session: sid, sessionName, area, duty: leadName, reason: "leads_to_zero",
              holders: inIvol.slice(0, 25), holderCount: inIvol.length });
          } else if (who.length) {
            counts.removed++; counts.cleared += who.length;
            removed.push({ session: sid, sessionName, area, duty: leadName, clearing: who });
          }
        }
      }
    }
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
      areas: areas.map(a => {
        const minTotal = byArea[a].reduce((n, r) => n + r.min, 0);
        const leadsTotal = byArea[a].reduce((n, r) => n + r.leads, 0);
        return {
          area: a, duties: byArea[a].length, minTotal, leadsTotal,
          // Leads are ADDITIONAL people, so this is what the area actually has to staff. Computed
          // here rather than left for the screen to add up, because getting it wrong understates
          // every area by its lead count.
          peopleNeeded: minTotal + leadsTotal,
          noTime: byArea[a].filter(r => !r.checkIn).length,
          rows: byArea[a],
          // The lead duties the ENGINE will generate from these rows. Derived by the engine's own
          // function, not re-implemented, so the preview cannot promise something else.
          derived: expandRoster(byArea[a]).filter(x => x.isLead),
        };
      }),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // A roster is per SESSION x area. The template carries one sheet per session, so a sheet left blank
  // leaves that session with no roster for the area — and because `summary` only covers sessions that
  // were touched, an untouched session simply vanished from the report. Uploading a template with only
  // the first sheet filled in therefore looked like the whole area was done, while the other session
  // stayed unreviewable. Report the gaps explicitly: for every area in this upload, the sessions that
  // end up with nothing — counting what is already committed, so a session rostered earlier and not
  // mentioned in this file is not flagged.
  const gaps = [...areasTouched].sort().map(area => {
    const missing = (sessions || []).filter(s => {
      const sid = String(s.id);
      const fresh = ((roster[sid] || {})[area] || []).length;
      const kept = (((opts.current || {})[sid] || {})[area] || []).length;
      return !fresh && !kept;
    }).map(s => ({ id: s.id, name: s.name }));
    return { area, sessions: missing };
  }).filter(g => g.sessions.length);

  counts.blocked = blocked.length;
  return { roster, newDuties, problems, warnings, removed, blocked, untouched, counts, summary, gaps,
    areasTouched: [...areasTouched].sort(), sessionsTouched: [...sessionsTouched] };
}

module.exports = { planRoster, parseCheckIn, parseCount, parseRemove };
