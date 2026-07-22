// Targeted allocation — deliberately top up ONE area by a set number of people, under an age guard.
//
// The percentage engine (api/allocate) distributes the whole pool at once. This is the opposite tool:
// the bulk of allocation is done, and what's left is "put 40 more people into Food Services, 19+".
// It is a separate endpoint on purpose — it must not be able to disturb the main plan, and a small
// operation with its own guards is far easier to reason about while the event is live.
//
// PREVIEW then COMMIT, and the commit takes the ID LIST the preview produced rather than re-picking.
// The operator commits exactly the people they were shown; every one of them is re-checked against
// every guard at write time, so anyone who was picked up by a caller in between is skipped, not stolen.
//
// GUARDS, in the order they exclude someone:
//   • called, resolved, or simply on a caller's list  -> never touched (same live guard as api/allocate)
//   • blocked / inactive / Leadership                 -> out of the pipeline entirely
//   • already holds an area                           -> this tops up the unplaced, it never moves people
//   • contested (competing review claims)             -> review owns them; never auto-resolved here
//   • declined this area                              -> a hard no; the volunteer actively refused it
//   • the AREA's own age window                       -> always applies, on top of the operator's guard,
//       because the duty allocation enforces the same window later. Placing a 17-year-old into a 19+
//       area would only produce someone the duty engine then refuses. See api/shared/eventage.js.
//   • the operator's age guard (min/max)              -> this run's extra narrowing
//   • no age on file                                  -> never eligible under an age gate; can't verify
//
// PICKS — by default only people who chose this area, or said happy-anywhere, are eligible, which is
// the rule the main engine follows. The operator can widen it per run (respectPicks:false): the newer
// areas did not exist at registration, so nobody could have picked them.
const { getContainer, readRegion, mergeRegion, REGIONS, readDidars } = require("../shared/store");
const { computeCallableStatus, seedEventAssignments, callerLocked } = require("../shared/status");
const { ALL_AREAS, ASSIGN_TARGETS, eligible } = require("../allocate/alloc");
const { notAssignable, LEADERSHIP_STATUS } = require("../shared/rollup");
const { AS_OF, ageOfOn } = require("../shared/eventage");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const DEFAULT_SEED = 20260723;
const clean = (s) => String(s == null ? "" : s).trim();
const nameOf = (v) => ((v.first || "") + " " + (v.last || "")).trim() || "(no name)";

// Same generator the main allocation uses, so "shuffled" means the same thing in both.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

// Why this person cannot be placed into this area, or null if they can. One function, used for the
// preview AND re-used verbatim at commit — the two can never drift apart.
function blockedReason(v, area, areaTarget, guard, respectPicks) {
  if (callerLocked(v) || v.assigned_caller) return "with a caller";
  if (notAssignable(v)) return "blocked or inactive";
  if (v.callable_status === LEADERSHIP_STATUS) return "leadership";
  if (clean(v.final_area)) return "already has an area";
  if (Array.isArray(v.conflict_claims) && v.conflict_claims.length) return "contested in review";
  const declined = Array.isArray(v.declined_areas) ? v.declined_areas : [];
  if (declined.some(a => clean(a).toLowerCase() === area.toLowerCase())) return "declined this area";
  const age = ageOfOn(v, AS_OF);
  if (age == null) return "no age on file";
  if (!eligible(age, areaTarget)) return "outside the area's age range";
  if (guard.min != null && age < guard.min) return "under your age guard";
  if (guard.max != null && age > guard.max) return "over your age guard";
  if (respectPicks) {
    const picks = Array.isArray(v.pref_areas) ? v.pref_areas.map(clean) : [];
    if (!v.happy_anywhere && !picks.some(a => a.toLowerCase() === area.toLowerCase())) return "did not pick this area";
  }
  return null;
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = (principal && principal.userDetails) || "";
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }

    const body = req.body || {};
    const area = clean(body.area);
    if (!ALL_AREAS.includes(area)) { context.res = { status: 400, body: { error: "Pick a process area." } }; return; }

    const commit = body.mode === "commit";
    const respectPicks = body.respectPicks !== false;          // default: only people who chose this area
    const seed = Number.isFinite(body.seed) ? body.seed : DEFAULT_SEED;
    const num = (x) => (x === "" || x == null || !Number.isFinite(Number(x))) ? null : Number(x);
    const guard = { min: num(body.minAge), max: num(body.maxAge) };
    if (guard.min != null && guard.max != null && guard.min > guard.max) {
      context.res = { status: 400, body: { error: "The minimum age is above the maximum." } }; return;
    }
    const count = Number(body.count);
    if (!commit && (!Number.isFinite(count) || count < 1)) {
      context.res = { status: 400, body: { error: "How many volunteers should go into this area?" } }; return;
    }

    // The area's own age window is a hard gate; areas with no configured window fall back to the
    // app-wide 16 floor that eligible() applies when min is null.
    const areaTarget = ASSIGN_TARGETS.find(t => t.area === area) || { area, min: null, max: null };

    // Scope: a Didar owns a region set, exactly as api/allocate scopes.
    const allDidars = await readDidars();
    const eventId = clean(body.event);
    const didar = eventId ? allDidars.find(d => String(d.id) === eventId) : null;
    if (eventId && !didar) { context.res = { status: 400, body: { error: "Unknown event." } }; return; }
    const scopeRegions = didar ? REGIONS.filter(r => (didar.regions || []).indexOf(r) >= 0) : REGIONS;
    if (!scopeRegions.length) { context.res = { status: 400, body: { error: "That event has no regions configured yet." } }; return; }

    const container = await getContainer(DATA_CONTAINER);
    const window = { min: areaTarget.min != null ? areaTarget.min : 16, max: areaTarget.max };

    // ---------------- COMMIT: write exactly the people the preview produced ----------------
    if (commit) {
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) { context.res = { status: 400, body: { error: "Nothing to allocate — preview first." } }; return; }
      const wanted = new Map();                       // region -> Set(user_id)
      for (const it of items) {
        const rg = clean(it && it.region), uid = it && it.user_id;
        if (!REGIONS.includes(rg) || uid == null) continue;
        if (!scopeRegions.includes(rg)) continue;
        if (!wanted.has(rg)) wanted.set(rg, new Set());
        wanted.get(rg).add(String(uid));
      }
      const didars = await readDidars();
      const res = { ok: true, area, mode: "commit", allocated: 0, skipped: [], names: [] };
      for (const region of scopeRegions) {
        const ids = wanted.get(region);
        if (!ids || !ids.size) continue;
        await mergeRegion(container, region, (existing) => existing.map(v => {
          if (!ids.has(String(v.user_id))) return v;
          // Re-check EVERY guard against the record as it is right now. Between preview and commit a
          // caller may have picked this person up; they are left exactly where they are.
          const why = blockedReason(v, area, areaTarget, guard, respectPicks);
          if (why) { res.skipped.push({ user_id: v.user_id, name: nameOf(v), region, reason: why }); return v; }
          const nv = { ...v };
          nv.final_area = area;
          nv.conflict_claims = [];
          nv.alloc_category = null;                   // no longer held aside
          nv.callable_status = computeCallableStatus(nv);
          nv.event_assignments = seedEventAssignments(nv, didars);
          nv.activity_log = (nv.activity_log || []).concat([{
            ts: new Date().toISOString(), actor: email || "alloctarget", action: "allocation",
            bucket: "assigned", area, via: "targeted",
            guard: { min: guard.min, max: guard.max }, respectPicks,
          }]);
          res.allocated++;
          if (res.names.length < 200) res.names.push(nameOf(v));
          return nv;
        }));
      }
      const bits = [`${res.allocated} volunteer(s) allocated to ${area}.`];
      if (res.skipped.length) bits.push(`${res.skipped.length} skipped \u2014 they changed since the preview (see below).`);
      res.note = bits.join(" ");
      context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(res) };
      return;
    }

    // ---------------- PREVIEW: who is eligible, who would be taken ----------------
    const tiers = { picked: [], happy: [], other: [] };
    const reasons = {};
    let scanned = 0;
    const seen = new Set();                            // a region change can leave a stale copy in two shards
    for (const region of scopeRegions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        const id = String(v.user_id);
        if (seen.has(id)) continue;
        seen.add(id);
        scanned++;
        const why = blockedReason(v, area, areaTarget, guard, respectPicks);
        if (why) { reasons[why] = (reasons[why] || 0) + 1; continue; }
        const picks = Array.isArray(v.pref_areas) ? v.pref_areas.map(clean) : [];
        const pickedThis = picks.some(a => a.toLowerCase() === area.toLowerCase());
        const row = {
          user_id: v.user_id, region, name: nameOf(v), jk: clean(v.ceremony_jk),
          age: ageOfOn(v, AS_OF),
          iff: (v.list === "IFF") || !!v.interfaith,
          heldAside: clean(v.alloc_category) || null,   // Young Volunteers / IFF / No age on file
          why: pickedThis ? "picked this area" : (v.happy_anywhere ? "happy anywhere" : "widened"),
        };
        if (pickedThis) tiers.picked.push(row);
        else if (v.happy_anywhere) tiers.happy.push(row);
        else tiers.other.push(row);
      }
    }

    // People who asked for this area go first, then happy-anywhere, then (only when widened) the rest.
    // Shuffled within each tier so repeated runs don't always favour the same Jamatkhana, and seeded
    // so the same seed reproduces the same pick.
    const rng = mulberry32(seed);
    const ordered = shuffle(tiers.picked, rng).concat(shuffle(tiers.happy, rng)).concat(shuffle(tiers.other, rng));
    const selected = ordered.slice(0, count);
    const eligibleTotal = ordered.length;

    context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      ok: true, mode: "preview", area, asOf: AS_OF, seed, respectPicks,
      guard, areaWindow: window,
      event: didar ? { id: didar.id, name: didar.name, regions: scopeRegions } : null,
      regions: scopeRegions, scanned,
      requested: count, eligibleTotal, selectedCount: selected.length,
      shortfall: Math.max(0, count - selected.length),
      byTier: { picked: tiers.picked.length, happy: tiers.happy.length, other: tiers.other.length },
      selectedByTier: {
        picked: selected.filter(s => s.why === "picked this area").length,
        happy: selected.filter(s => s.why === "happy anywhere").length,
        other: selected.filter(s => s.why === "widened").length,
      },
      heldAsideSelected: selected.filter(s => s.heldAside).length,
      iffSelected: selected.filter(s => s.iff).length,
      excluded: Object.entries(reasons).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
      selected,
      note: selected.length < count
        ? `Only ${selected.length} of the ${count} requested are eligible for ${area} right now — see what ruled people out below.`
        : `${selected.length} volunteer(s) ready to allocate to ${area}. Nothing is written until you commit.`,
    }) };
  } catch (err) {
    context.log && context.log.error && context.log.error("alloctarget failed:", (err && err.stack) || err);
    context.res = { status: 500, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String((err && err.message) || err) }) };
  }
};
