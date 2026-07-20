// Reassign everyone out of one area (Medical Services is being dissolved) into a set of target areas,
// balanced. Called PER REGION, because areas are staffed within a region's Didar — a Prairies volunteer
// can only serve a Prairies area, so each region's people are spread across the targets independently.
//
// Assignment rule: honour interest first. If a person listed any target in their pref_areas, they go to
// one of those; otherwise they fill wherever keeps the split most even. Among the eligible targets we
// pick the least-loaded so far (ties break by target order), which honours interest while pushing the
// distribution toward even. Deterministic (stable sort + fixed tie-break) so the dry-run and the commit
// produce the identical plan.
const clean = (s) => String(s == null ? "" : s).trim();
const norm = (s) => clean(s).toLowerCase();

const DEFAULT_FROM = "Medical Services";
const DEFAULT_TARGETS = ["Safety & Flow Management", "Seniors & Mobility", "Reception & Hospitality"];

// records = ONE region's records. Returns { from, targets, count, counts, byReason, plan }.
function planReassign(records, opts = {}) {
  const from = opts.from || DEFAULT_FROM;
  const targets = (opts.targets && opts.targets.length) ? opts.targets : DEFAULT_TARGETS;
  const counts = {}; targets.forEach(t => { counts[t] = 0; });
  const byReason = { interest: 0, balanced: 0 };
  const plan = [];

  const people = (records || []).filter(v => v && norm(v.final_area) === norm(from));
  // stable, data-independent order so the split is reproducible
  people.sort((a, b) => String(a.region || "").localeCompare(String(b.region || "")) || String(a.user_id).localeCompare(String(b.user_id)));

  for (const v of people) {
    const prefs = Array.isArray(v.pref_areas) ? v.pref_areas : [];
    const interested = targets.filter(t => prefs.some(p => norm(p) === norm(t)));
    const candidates = interested.length ? interested : targets;
    let pick = candidates[0];
    for (const c of candidates) if (counts[c] < counts[pick]) pick = c;   // least-loaded, ties -> earlier target
    counts[pick]++;
    const reason = interested.length ? "interest" : "balanced";
    byReason[reason]++;
    plan.push({ user_id: v.user_id, region: v.region, name: (clean((v.first || "") + " " + (v.last || "")) || ("#" + v.user_id)),
      from, to: pick, reason });
  }
  return { from, targets, count: plan.length, counts, byReason, plan };
}

// Move ONE person: point final_area and their existing event_assignments rows at the new area (duty
// selection reads the row's area), keeping session/state on those rows. Records the old area for audit.
function applyReassign(v, to, from, actor, nowIso) {
  v.referred_from = v.final_area;
  v.final_area = to;
  for (const row of (Array.isArray(v.event_assignments) ? v.event_assignments : [])) {
    if (row && (norm(row.area) === norm(from) || !clean(row.area))) row.area = to;
  }
  v.activity_log = v.activity_log || [];
  v.activity_log.push({ ts: nowIso, actor, action: "area_reassigned", from, to,
    note: from + " dissolved; reassigned by interest and balance." });
}

module.exports = { planReassign, applyReassign, DEFAULT_FROM, DEFAULT_TARGETS };
