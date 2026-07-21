// Bulk allocation engine — pure function over stored volunteer records.
// Deterministic given the same records + seed (preview and commit match).
//
// Model (per region):
//   1. Review-migration assignments stay fixed (final_area kept) — including Medical
//      Services & Registration & Access. ("affinity")
//   2. Held aside, never allocated: IFF, under-16 (Young), no birthday/age.
//   3. Targets are a goal for the FINAL mix. For each of the 7 percentage areas,
//        goal = round(pct * D),  where D = (review-fixed + assignable) in the region.
//      Areas are filled LOWEST-% first (one head matters more in a small area).
//   4. Pass 1 — "happy to serve anywhere" people fill those needs (any area, age-gated).
//      Pass 2 — everyone else goes into one of THEIR OWN picked areas (multi-pick = the
//      flexible lever), lowest-% first. People who picked nothing act as last-resort filler.
//   5. Anyone left over (no eligible picked area / age-ineligible) stays Unassigned.

const REGIONS = ["BC", "Prairies", "Edmonton"];

const ALL_AREAS = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics", "Registration & Access",
  "Medical Services", "Diverse Abilities Support", "Finance & Procurement", "Environmental Sustainability",
  "Memorabilia & Design", "Jamati Preparation",
  "Volunteer Engagement", "Operations Centre", "Communications",
];
const SPECIAL = ["In reconciliation", "Young Volunteers", "IFF", "No age on file", "Unassigned"];

// Goal split for the FINAL distribution. pct of D; min/max are hard age gates.
const ASSIGN_TARGETS = [
  { area: "Safety & Flow Management",      pct: 0.53, min: 19, max: null },
  { area: "Seniors & Mobility",           pct: 0.14, min: 16, max: 55 },
  { area: "Reception & Hospitality",      pct: 0.14, min: null, max: null },
  { area: "Environmental Sustainability", pct: 0.02, min: 13, max: 30 },
  { area: "Parking & Transportation",     pct: 0.07, min: 19, max: 65 },
  { area: "Food Services",                pct: 0.04, min: 16, max: null },
  { area: "Layout & Logistics",           pct: 0.04, min: 19, max: 65 },
  { area: "Memorabilia & Design",         pct: 0.02, min: 16, max: null },
  { area: "Registration & Access",         pct: 0, min: 16, max: null },
  { area: "Medical Services",              pct: 0, min: null, max: null },
  { area: "Diverse Abilities Support",            pct: 0, min: null, max: null },
  { area: "Volunteer Engagement",          pct: 0, min: 16, max: null },
  { area: "Operations Centre",             pct: 0, min: 16, max: null },
  { area: "Communications",                pct: 0, min: 16, max: null },
];

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
// Shared with the DUTY allocation on purpose: two gates, one definition of age, so they can never
// disagree about whether someone is old enough. See api/shared/eventage.js.
const { ageAsOf } = require("../shared/eventage");
function eligible(age, t) {
  if (!t) return false;
  // 16 is the floor for everyone UNLESS an area explicitly sets a lower min (e.g. Environmental at 13).
  // This keeps "any age" areas at 16+ and confines the under-16 carve-out to the areas that opt into it.
  const min = (t.min != null) ? t.min : 16;
  if (age == null || age < min) return false;
  if (t.max != null) { if (age == null || age > t.max) return false; }
  return true;
}
function sanitizeTargets(t) {
  if (!Array.isArray(t) || !t.length) return null;
  const out = [];
  for (const x of t) {
    if (!x || typeof x.area !== "string") return null;
    const pct = Number(x.pct);
    if (!Number.isFinite(pct) || pct < 0) return null;
    out.push({ area: x.area, pct, min: Number.isFinite(x.min) ? x.min : null, max: Number.isFinite(x.max) ? x.max : null });
  }
  return out;
}
// Fill order: LOWEST percentage first (a head matters more in a small area); ties broken by
// the narrower age window first (so a constrained-eligibility area isn't starved), then name.
function fillOrderByPct(targets) {
  return targets.slice().sort((a, b) => {
    if (a.pct !== b.pct) return a.pct - b.pct;
    const wa = (a.max == null ? 200 : a.max) - (a.min == null ? 0 : a.min);
    const wb = (b.max == null ? 200 : b.max) - (b.min == null ? 0 : b.min);
    if (wa !== wb) return wa - wb;
    return a.area.localeCompare(b.area);
  });
}

function allocate(records, cfg) {
  cfg = cfg || {};
  const asOf = cfg.asOf || "2026-07-23";
  const seed = (cfg.seed != null ? cfg.seed : 1234567) >>> 0;
  const targetsDef = sanitizeTargets(cfg.targets) || ASSIGN_TARGETS;
  const orderAll = fillOrderByPct(targetsDef);
  const order = orderAll.filter(t => t.area !== "Medical Services");   // Medical is cert-driven (medical pass), never %-filled
  const tByArea = {}; targetsDef.forEach(t => (tByArea[t.area] = t));
  const rng = mulberry32(seed);
  // Allocate only the given regions when scoped to an event (a Didar owns a region set); default = all.
  const regionsUsed = (Array.isArray(cfg.regions) && cfg.regions.length)
    ? REGIONS.filter(r => cfg.regions.indexOf(r) >= 0) : REGIONS;

  // Annotate + initial bucket.
  const recs = records.map(r => {
    const directAge = (r.age != null && Number.isFinite(Number(r.age))) ? Number(r.age) : null;
    const claims = Array.isArray(r.conflict_claims) ? r.conflict_claims.length : 0;
    const fromReview = (r.never_reviewed === false) || claims > 0;   // review touched (incl. contested)
    const prefAreas = Array.isArray(r.pref_areas) ? r.pref_areas.filter(a => typeof a === "string") : [];
    return {
      user_id: r.user_id, region: r.region, email: r.email,
      computed_area: r.computed_area || null,
      final_area: r.final_area || null, leader: !!r.leader_flag, claims, fromReview,
      age: directAge != null ? directAge : ageAsOf(r.birthday, asOf),
      isIFF: (r.list === "IFF") || !!r.interfaith,
      prefAreas, happyAnywhere: !!r.happy_anywhere,
      declinedAreas: Array.isArray(r.declined_areas) ? r.declined_areas.filter(a => typeof a === "string") : [],
      bucket: null, area: null,
    };
  }).filter(r => regionsUsed.indexOf(r.region) >= 0);   // scoped to the event's regions when cfg.regions set

  // Areas that explicitly admit volunteers under 16 (e.g. Environmental at 13+). An under-16
  // person is only released from the "Young" hold if they can actually serve one of these —
  // i.e. they're happy-anywhere (or picked it) and fall in its age window. Everyone else under 16
  // stays held aside as before.
  // An area this person has actively REFUSED (Accepted screen -> decline+refer, or repool). This is
  // NOT the same as simply not preferring it: it is a person having said no, and it outranks every
  // other signal here — their Better Impact picks, happy-anywhere, a Medical cert, a family match.
  // It cannot be expressed by editing pref_areas, because Better Impact owns that field and rewrites
  // it on every refresh (see mergeFresh); declined_areas is app-owned and survives. Empty for
  // everyone who has never declined, so canGo() is a no-op on the entire existing population.
  const canGo = (p, area) => p.declinedAreas.length === 0 || p.declinedAreas.indexOf(area) < 0;

  const subSixteen = targetsDef.filter(t => t.min != null && t.min < 16);
  const youngCanServe = (r) => subSixteen.some(t =>
    eligible(r.age, t) && canGo(r, t.area) && (r.happyAnywhere || r.prefAreas.indexOf(t.area) >= 0));

  for (const r of recs) {
    if (r.fromReview) {
      if (r.final_area != null) { r.bucket = "affinity"; r.area = r.final_area; }  // stays put
      else { r.bucket = "contested"; r.area = null; }                              // pending, left alone
      continue;
    }
    if (r.isIFF) { r.bucket = "iff"; continue; }          // held aside
    // Medical Services first pass: healthcare professionals / health-cert holders (flagged at import
    // as computed_area = "Medical Services") are placed in Medical up front — Medical always wins —
    // regardless of the no-age/young holds. Reviewed people are handled above, so this only catches the
    // un-reviewed medical pool that would otherwise be re-allocated into a percentage area.
    // "Medical always wins" — except over a person who has actually refused Medical. A decline is an
    // explicit human decision; a cert flag is an import heuristic. They fall through to the normal
    // pool and are placed by their remaining preferences.
    if (cfg.medicalFirst !== false && r.computed_area === "Medical Services" && canGo(r, "Medical Services")) {
      r.bucket = "assigned"; r.area = "Medical Services"; r.medicalPass = true; continue;
    }
    if (r.age == null) { r.bucket = "noage"; continue; }  // held aside (no birthday)
    if (r.age < 16 && !youngCanServe(r)) { r.bucket = "young"; continue; }  // under-16 held aside unless an area admits them
    r.bucket = "pool";                                    // assignable
  }

  const distReport = {};
  for (const R of regionsUsed) {
    const regionRecs = recs.filter(x => x.region === R);
    const reviewFixed = regionRecs.filter(x => x.bucket === "affinity");
    const assignable = regionRecs.filter(x => x.bucket === "pool");
    const D = reviewFixed.length + assignable.length;     // denominator for the goal counts

    const reviewIn = {};
    for (const x of reviewFixed) if (x.area) reviewIn[x.area] = (reviewIn[x.area] || 0) + 1;

    const target = {}, need = {}, placed = {};
    for (const t of targetsDef) {
      target[t.area] = Math.round(t.pct * D);
      need[t.area] = Math.max(0, target[t.area] - (reviewIn[t.area] || 0));  // review already there counts
      placed[t.area] = 0;
    }
    // Medical first-pass people are already placed in Medical (cert-driven, not %-filled); count them so
    // the Medical distribution row reflects them against any goal you set.
    for (const x of regionRecs) if (x.medicalPass) placed[x.area] = (placed[x.area] || 0) + 1;

    // ---- Distribution -------------------------------------------------------
    // Preference is a HARD wall: nobody is ever placed in an area they didn't pick; only the
    // "happy anywhere" people can go anywhere. Two phases run in an order set by cfg.happyFirst:
    //   - PICKERS: each area is topped up from its own pickers over X capped rounds (need*k/X).
    //   - HAPPY:   seed the no-picker areas (Environmental, Memorabilia) to target first, then fill
    //              everyone else over X capped passes, ordering open areas by cfg.flexOrder:
    //                "below"  = furthest below target first (== highest-% first while areas are empty),
    //                "scarce" = fewest remaining candidates first (protects narrowly-staffable areas).
    // Overflow (below) then mops up whoever is left so no one is Unassigned. The X knob is cfg.rounds.
    const rounds = Math.max(1, Math.min(20, cfg.rounds != null ? (cfg.rounds | 0) : 4));
    const happyFirst = !!cfg.happyFirst;
    const flexBelow = (cfg.flexOrder !== "scarce");   // default: furthest-below-target
    const fillArea = (p, A) => { p.bucket = "assigned"; p.area = A; placed[A]++; };

    // Each area's own picker candidates (non-flex, age-eligible), shuffled.
    const pickersByArea = {};
    for (const t of targetsDef) {
      pickersByArea[t.area] = shuffle(
        assignable.filter(p => !p.happyAnywhere && p.prefAreas.indexOf(t.area) >= 0
          && eligible(p.age, tByArea[t.area]) && canGo(p, t.area)),
        rng
      );
    }
    const flex = shuffle(assignable.filter(p => p.happyAnywhere), rng);
    const remainingPickerSupply = (A) => pickersByArea[A].filter(p => !p.area).length;
    // canGo is load-bearing HERE above all: flex placement never consults preferences, so without it
    // a happy-anywhere volunteer who refused an area gets put straight back into it.
    const eligibleFlexOpen = (A) => flex.filter(x => !x.area && eligible(x.age, tByArea[A]) && canGo(x, A));
    const fitCount = (p, areas) => areas.reduce((n, t) => n + (eligible(p.age, tByArea[t.area]) && canGo(p, t.area) ? 1 : 0), 0);
    // Place ONE flex person into A, choosing the one LEAST useful to the other open areas, so
    // dual-use people are saved for the areas that still need them and narrow people land where
    // only they can serve.
    function placeFlexInto(A, otherAreas) {
      const pool = eligibleFlexOpen(A);
      if (!pool.length) return false;
      let person = pool[0], lowFit = fitCount(person, otherAreas);
      for (const p of pool) { const f = fitCount(p, otherAreas); if (f < lowFit) { lowFit = f; person = p; } }
      fillArea(person, A);
      return true;
    }

    // PICKERS: cap each area at (k/X) of its need; advance all areas together, lowest-% first.
    function phasePickers() {
      for (let k = 1; k <= rounds; k++) {
        for (const t of order) {
          const A = t.area;
          const cap = Math.round((need[A] * k) / rounds);
          for (const p of pickersByArea[A]) {
            if (placed[A] >= cap) break;
            if (!p.area) fillArea(p, A);               // pickers only into their own area
          }
        }
      }
    }

    // HAPPY: seed the no-picker areas to target, then X capped passes ordered by cfg.flexOrder.
    function phaseHappy() {
      const noPicker = order.filter(t => pickersByArea[t.area].length === 0 && need[t.area] > 0);
      for (const t of noPicker) {
        const A = t.area;
        while (placed[A] < need[A]) {
          if (!placeFlexInto(A, order.filter(o => o.area !== A))) break;   // no eligible flex left
        }
      }
      for (let k = 1; k <= rounds; k++) {
        const cap = (A) => Math.round((need[A] * k) / rounds);
        while (true) {
          const open = order.filter(t => placed[t.area] < cap(t.area) && eligibleFlexOpen(t.area).length);
          if (!open.length) break;
          let pick = null;
          if (flexBelow) {                              // furthest below target first (highest-% while empty)
            let best = -Infinity, bestPct = -Infinity;
            for (const t of open) {
              const shortfall = need[t.area] - placed[t.area];
              if (shortfall > best || (shortfall === best && t.pct > bestPct)) { best = shortfall; bestPct = t.pct; pick = t; }
            }
          } else {                                      // scarcest first (fewest people who can still fill it)
            let bestN = Infinity, bestPct = Infinity;
            for (const t of open) {
              const n = eligibleFlexOpen(t.area).length + remainingPickerSupply(t.area);
              if (n < bestN || (n === bestN && t.pct < bestPct)) { bestN = n; bestPct = t.pct; pick = t; }
            }
          }
          if (!pick) break;
          placeFlexInto(pick.area, open.filter(t => t.area !== pick.area));
        }
      }
    }

    if (happyFirst) { phaseHappy(); phasePickers(); }
    else { phasePickers(); phaseHappy(); }

    // ---- Overflow (optional) ------------------------------------------------
    // With overflow ON, nobody is left Unassigned just because their picked areas hit their caps.
    // Each remaining person is pushed into one of the areas THEY SELECTED (happy-anywhere -> any),
    // age-eligible, choosing the one that is currently least subscribed (lowest filled-vs-goal
    // ratio) so the overflow tops up under-target areas first and only piles on as overage when all
    // their picks are already full. The resulting over-goal counts show which areas are
    // oversubscribed, so their percentages can be trimmed to feed the under-subscribed ones.
    //
    // Cross-eligibility (overflow ONLY): two chronically short areas borrow from the oversubscribed
    // Reception & Hospitality pool during this final sweep, so leftover hospitality folks divert into
    // them instead of re-piling onto Reception:
    //   - Seniors & Mobility: a Hospitality picker is treated as also selecting Seniors, gated by
    //     Seniors' own age range (set in the UI). Widen Seniors' max age there to pull older
    //     Hospitality leftovers in; narrow it to exclude them.
    //   - Safety & Flow Management: a Hospitality picker is treated as also selecting Safety, gated by
    //     Safety's own 19+ rule (no upper cap — Safety needs a broad adult pool). Edit Safety's max
    //     age in the UI if you want to bound it.
    // Each only WIDENS the "selected" set; the area's own age gate still applies via eligible(), and
    // the main passes are unchanged. A Hospitality leftover eligible for both Safety and Seniors goes
    // to whichever is more behind its goal (least-subscribed-ratio rule).
    if (cfg.overflow) {
      const SENIORS = "Seniors & Mobility", HOSPITALITY = "Reception & Hospitality", SAFETY = "Safety & Flow Management";
      const hospitality = (p) => p.prefAreas.indexOf(HOSPITALITY) >= 0;
      const seniorsCross = (p) => hospitality(p);   // age handled by Seniors' own range in eligible()
      const safetyCross = (p) => hospitality(p);    // age handled by Safety's 19+ gate in eligible()
      const leftover = shuffle(assignable.filter(p => !p.area), rng);
      for (const p of leftover) {
        let area = null, bestRatio = Infinity, bestPct = Infinity;
        for (const t of order) {
          if (!eligible(p.age, tByArea[t.area])) continue;
          // canGo first: overflow WIDENS the selected set (hospitality -> Seniors/Safety), and a refusal
          // must not be widened around.
          const selected = canGo(p, t.area) && (p.happyAnywhere || p.prefAreas.indexOf(t.area) >= 0
            || (t.area === SENIORS && seniorsCross(p))
            || (t.area === SAFETY && safetyCross(p)));
          if (!selected) continue;
          const ratio = placed[t.area] / Math.max(1, target[t.area]);
          if (ratio < bestRatio || (ratio === bestRatio && t.pct < bestPct)) { bestRatio = ratio; bestPct = t.pct; area = t.area; }
        }
        if (area) fillArea(p, area);     // over the cap allowed; still only into a selected (or cross-eligible) area
      }
    }

    // Leftover assignable (picked only full areas / not flex) -> Unassigned, with the reason why.
    for (const p of assignable) {
      if (p.area) continue;
      p.bucket = "unassigned";
      const picks = Array.isArray(p.prefAreas) ? p.prefAreas : [];
      const targetPicks = picks.filter(a => tByArea[a]);           // picks that are real allocation targets
      const validPicks = targetPicks.filter(a => canGo(p, a));     // ...that they haven't refused
      if (!p.happyAnywhere && picks.length === 0) { p.reason = "No area selected"; continue; }
      if (!p.happyAnywhere && targetPicks.length === 0) { p.reason = "Only picked non-target areas (e.g. Medical/Registration)"; continue; }
      if (!p.happyAnywhere && validPicks.length === 0) { p.reason = "Declined every area they picked"; continue; }
      const willing = (p.happyAnywhere ? order.map(t => t.area) : validPicks).filter(a => canGo(p, a));
      if (willing.length === 0) { p.reason = "Declined every area"; continue; }
      const ageOk = willing.filter(a => eligible(p.age, tByArea[a]));
      if (ageOk.length === 0) { p.reason = p.happyAnywhere ? "Age-ineligible for every area" : "Age outside the range of every area they picked"; continue; }
      p.reason = cfg.overflow ? "Picked areas at capacity" : "Picked areas full (overflow off)";
    }

    distReport[R] = {
      D, reviewFixed: reviewFixed.length, assignable: assignable.length, rounds,
      flexTotal: assignable.filter(p => p.happyAnywhere).length,
      targets: orderAll.map(t => {
        const A = t.area;
        const certDriven = (A === "Medical Services");   // filled by the medical pass, not pickers/flex
        // Ceiling = the most this area could EVER reach without violating preference:
        // review already there + its own age-eligible pickers + all age-eligible flex people.
        const pickerCount = certDriven ? 0 : assignable.filter(p => !p.happyAnywhere && p.prefAreas.indexOf(A) >= 0 && eligible(p.age, tByArea[A]) && canGo(p, A)).length;
        const flexEligible = certDriven ? 0 : assignable.filter(p => p.happyAnywhere && eligible(p.age, tByArea[A]) && canGo(p, A)).length;
        return {
          area: A, pct: t.pct, target: target[A],
          reviewAlready: reviewIn[A] || 0, placed: placed[A],
          final: (reviewIn[A] || 0) + placed[A],
          ceiling: certDriven ? ((reviewIn[A] || 0) + placed[A]) : ((reviewIn[A] || 0) + pickerCount + flexEligible),   // cert-driven: maxes at who is actually in it
          shortBy: Math.max(0, target[A] - ((reviewIn[A] || 0) + placed[A])),
          over: Math.max(0, ((reviewIn[A] || 0) + placed[A]) - target[A]),  // overage when overflow is on
        };
      }),
      unplaced: assignable.filter(p => p.bucket === "unassigned").length,
    };
  }

  // ---- Young-volunteer family match (ages 5–13) -------------------------------------------------
  // After the main allocation, place a held-aside young volunteer with family: the area of their OLDEST
  // same-email relative who's already been allocated to an area (fall back to any allocated same-email
  // person if none of the relatives have an age on file). They're only placed if their own age fits that
  // area's age range — no bypassing the gate — so lowering an area's min in the UI is the lever for
  // admitting them. No same-email match, or the area doesn't admit their age -> they stay held aside.
  let youngFamilyPlaced = 0; const youngFamilyByArea = {};
  if (cfg.youngFamilyMatch !== false) {
    const YMIN = 5, YMAX = 13;
    const normEmail = e => String(e == null ? "" : e).trim().toLowerCase();
    const allocatedByEmail = new Map();                 // built ONCE, so youngsters match adults, not each other
    for (const r of recs) {
      if (!r.area) continue;                            // only people who actually landed in an area
      const em = normEmail(r.email); if (!em) continue;
      if (!allocatedByEmail.has(em)) allocatedByEmail.set(em, []);
      allocatedByEmail.get(em).push(r);
    }
    for (const r of recs) {
      if (r.bucket !== "young" || r.age == null || r.age < YMIN || r.age > YMAX) continue;
      const em = normEmail(r.email); if (!em) continue;
      const fam = (allocatedByEmail.get(em) || []).filter(x => String(x.user_id) !== String(r.user_id));
      if (!fam.length) continue;                        // no allocated same-email relative -> stays held aside
      const withAge = fam.filter(x => x.age != null);
      const chosen = withAge.length ? withAge.reduce((a, b) => (b.age > a.age ? b : a)) : fam[0];  // oldest, else any
      const t = tByArea[chosen.area];
      // A refusal outranks the family match too: being related to someone in an area is not consent
      // to serve in it.
      if (t && eligible(r.age, t) && canGo(r, chosen.area)) {     // only if the young volunteer's age fits that area's range
        r.bucket = "assigned"; r.area = chosen.area; r.youngFamily = true; r.youngFamilyWith = chosen.user_id;
        youngFamilyPlaced++; youngFamilyByArea[chosen.area] = (youngFamilyByArea[chosen.area] || 0) + 1;
      }
    }
  }

  const matrix = {};
  for (const R of regionsUsed) matrix[R] = {};
  for (const r of recs) {
    const R = r.region; if (!matrix[R]) matrix[R] = {};
    let key;
    if (r.bucket === "affinity" || r.bucket === "assigned") key = r.area || "Unassigned";
    else if (r.bucket === "contested") key = "In reconciliation";
    else if (r.bucket === "young") key = "Young Volunteers";
    else if (r.bucket === "iff") key = "IFF";
    else if (r.bucket === "noage") key = "No age on file";
    else key = "Unassigned";
    matrix[R][key] = (matrix[R][key] || 0) + 1;
  }

  const affinityTotal = recs.filter(r => r.bucket === "affinity").length;
  const affinityLeaders = recs.filter(r => r.bucket === "affinity" && r.leader).length;
  const contestedTotal = recs.filter(r => r.bucket === "contested").length;
  const nullAge = recs.filter(r => r.age == null).length;

  return {
    asOf, seed, matrix, affinityTotal, affinityLeaders, contestedTotal, nullAge, distReport,
    youngFamilyPlaced, youngFamilyByArea,
    medicalPlaced: recs.filter(r => r.medicalPass).length,
    mode: { rounds: Math.max(1, Math.min(20, cfg.rounds != null ? (cfg.rounds | 0) : 4)),
            happyFirst: !!cfg.happyFirst, flexOrder: (cfg.flexOrder !== "scarce" ? "below" : "scarce"),
            overflow: !!cfg.overflow, youngFamilyMatch: cfg.youngFamilyMatch !== false, medicalFirst: cfg.medicalFirst !== false },
    decisions: recs.map(r => ({ user_id: r.user_id, region: r.region, bucket: r.bucket, area: r.area, age: r.age, youngFamily: !!r.youngFamily, youngFamilyWith: r.youngFamilyWith || null, medicalPass: !!r.medicalPass, reason: r.reason || null })),
  };
}

module.exports = { allocate, ageAsOf, REGIONS, ALL_AREAS, SPECIAL, ASSIGN_TARGETS };
