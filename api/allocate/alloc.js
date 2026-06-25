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
  "Medical Services", "Finance & Procurement", "Environmental Sustainability",
  "Memorabilia & Design", "Jamati Preparation",
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
function ageAsOf(birthday, asOf) {
  if (!birthday) return null;
  const d = new Date(birthday); if (isNaN(d)) return null;
  const ref = new Date(asOf);
  let a = ref.getFullYear() - d.getFullYear();
  const m = ref.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < d.getDate())) a--;
  return a;
}
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
  const order = fillOrderByPct(targetsDef);
  const tByArea = {}; targetsDef.forEach(t => (tByArea[t.area] = t));
  const rng = mulberry32(seed);

  // Annotate + initial bucket.
  const recs = records.map(r => {
    const directAge = (r.age != null && Number.isFinite(Number(r.age))) ? Number(r.age) : null;
    const claims = Array.isArray(r.conflict_claims) ? r.conflict_claims.length : 0;
    const fromReview = (r.never_reviewed === false) || claims > 0;   // review touched (incl. contested)
    const prefAreas = Array.isArray(r.pref_areas) ? r.pref_areas.filter(a => typeof a === "string") : [];
    return {
      user_id: r.user_id, region: r.region,
      final_area: r.final_area || null, leader: !!r.leader_flag, claims, fromReview,
      age: directAge != null ? directAge : ageAsOf(r.birthday, asOf),
      isIFF: (r.list === "IFF") || !!r.interfaith,
      prefAreas, happyAnywhere: !!r.happy_anywhere,
      bucket: null, area: null,
    };
  });

  // Areas that explicitly admit volunteers under 16 (e.g. Environmental at 13+). An under-16
  // person is only released from the "Young" hold if they can actually serve one of these —
  // i.e. they're happy-anywhere (or picked it) and fall in its age window. Everyone else under 16
  // stays held aside as before.
  const subSixteen = targetsDef.filter(t => t.min != null && t.min < 16);
  const youngCanServe = (r) => subSixteen.some(t =>
    eligible(r.age, t) && (r.happyAnywhere || r.prefAreas.indexOf(t.area) >= 0));

  for (const r of recs) {
    if (r.fromReview) {
      if (r.final_area != null) { r.bucket = "affinity"; r.area = r.final_area; }  // stays put
      else { r.bucket = "contested"; r.area = null; }                              // pending, left alone
      continue;
    }
    if (r.isIFF) { r.bucket = "iff"; continue; }          // held aside
    if (r.age == null) { r.bucket = "noage"; continue; }  // held aside (no birthday)
    if (r.age < 16 && !youngCanServe(r)) { r.bucket = "young"; continue; }  // under-16 held aside unless an area admits them
    r.bucket = "pool";                                    // assignable
  }

  const distReport = {};
  for (const R of REGIONS) {
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

    // ---- Round-based fill ---------------------------------------------------
    // Preference is a HARD wall: nobody is ever placed in an area they didn't pick
    // (the "happy anywhere" people are the only exception — they can go anywhere).
    // We fill in rounds so the big area (Safety) can't soak up everyone before the
    // small areas get their share. Each round raises every area's cap a notch and we
    // top each area toward that cap from its own pickers. The flexible (happy-anywhere)
    // people are saved for LAST, then poured into the areas that have the fewest other
    // candidates first (Environmental has none; Safety is usually next), so they do the
    // most good. Anyone still unplaced at the end stays Unassigned — by design.
    const rounds = Math.max(1, Math.min(20, cfg.rounds != null ? (cfg.rounds | 0) : 4));
    const fillArea = (p, A) => { p.bucket = "assigned"; p.area = A; placed[A]++; };

    // Pre-bucket each area's own picker candidates (non-flex, age-eligible), shuffled.
    const pickersByArea = {};
    for (const t of targetsDef) {
      pickersByArea[t.area] = shuffle(
        assignable.filter(p => !p.happyAnywhere && p.prefAreas.indexOf(t.area) >= 0 && eligible(p.age, tByArea[t.area])),
        rng
      );
    }
    // Rounds: cap each area at (k/rounds) of its need; advance all areas together.
    for (let k = 1; k <= rounds; k++) {
      for (const t of order) {                       // lowest-% first within a round keeps small areas moving
        const A = t.area;
        const cap = Math.round((need[A] * k) / rounds);
        for (const p of pickersByArea[A]) {
          if (placed[A] >= cap) break;
          if (!p.area) fillArea(p, A);               // pickers only into their own area
        }
      }
    }

    // Flex pool LAST. Repeatedly take the OPEN area with the fewest people who can still
    // fill it (own leftover pickers + age-eligible flex) and give it one flex person —
    // choosing the person who is LEAST useful to the other open areas, so dual-use people
    // (e.g. 19-20s, who also qualify for Parking/Safety) are saved for the areas that still
    // need them and the narrow 16-20s land in Environmental, which only they can staff.
    // The broad area (Safety) has the largest candidate pool, so it fills last from the
    // residual — which is exactly the "flex to the areas with no other source first" rule.
    const remainingPickerSupply = (A) => pickersByArea[A].filter(p => !p.area).length;
    const flex = shuffle(assignable.filter(p => p.happyAnywhere), rng);
    const eligibleFlex = (A) => flex.filter(x => !x.area && eligible(x.age, tByArea[A]));
    const fitCount = (p, areas) => areas.reduce((n, t) => n + (eligible(p.age, tByArea[t.area]) ? 1 : 0), 0);
    while (true) {
      const open = order.filter(t => placed[t.area] < need[t.area]);
      if (!open.length) break;
      let area = null, pool = null, bestN = Infinity, bestRatio = Infinity, bestPct = Infinity;
      for (const t of open) {
        const e = eligibleFlex(t.area);
        if (!e.length) continue;                                  // no flex can serve this area
        const n = e.length + remainingPickerSupply(t.area);
        const ratio = placed[t.area] / need[t.area];
        if (n < bestN || (n === bestN && (ratio < bestRatio || (ratio === bestRatio && t.pct < bestPct)))) {
          bestN = n; bestRatio = ratio; bestPct = t.pct; area = t.area; pool = e;
        }
      }
      if (!area) break;                                           // no open area has any eligible flex left
      const others = open.filter(t => t.area !== area);
      let person = pool[0], lowFit = fitCount(person, others);
      for (const p of pool) { const f = fitCount(p, others); if (f < lowFit) { lowFit = f; person = p; } }
      fillArea(person, area);
    }

    // ---- Overflow (optional) ------------------------------------------------
    // With overflow ON, nobody is left Unassigned just because their picked areas hit their caps.
    // Each remaining person is pushed into one of the areas THEY SELECTED (happy-anywhere -> any),
    // age-eligible, choosing the one that is currently least subscribed (lowest filled-vs-goal
    // ratio) so the overflow tops up under-target areas first and only piles on as overage when all
    // their picks are already full. The resulting over-goal counts show which areas are
    // oversubscribed, so their percentages can be trimmed to feed the under-subscribed ones.
    // Preference is still a hard wall: we never place anyone outside their own picks.
    if (cfg.overflow) {
      const leftover = shuffle(assignable.filter(p => !p.area), rng);
      for (const p of leftover) {
        let area = null, bestRatio = Infinity, bestPct = Infinity;
        for (const t of order) {
          if (!eligible(p.age, tByArea[t.area])) continue;
          if (!(p.happyAnywhere || p.prefAreas.indexOf(t.area) >= 0)) continue;
          const ratio = placed[t.area] / Math.max(1, target[t.area]);
          if (ratio < bestRatio || (ratio === bestRatio && t.pct < bestPct)) { bestRatio = ratio; bestPct = t.pct; area = t.area; }
        }
        if (area) fillArea(p, area);     // over the cap allowed; still only into a selected area
      }
    }

    // Leftover assignable (picked only full areas / not flex) -> Unassigned, by design.
    for (const p of assignable) if (!p.area) p.bucket = "unassigned";

    distReport[R] = {
      D, reviewFixed: reviewFixed.length, assignable: assignable.length, rounds,
      flexTotal: assignable.filter(p => p.happyAnywhere).length,
      targets: order.map(t => {
        const A = t.area;
        // Ceiling = the most this area could EVER reach without violating preference:
        // review already there + its own age-eligible pickers + all age-eligible flex people.
        const pickerCount = assignable.filter(p => !p.happyAnywhere && p.prefAreas.indexOf(A) >= 0 && eligible(p.age, tByArea[A])).length;
        const flexEligible = assignable.filter(p => p.happyAnywhere && eligible(p.age, tByArea[A])).length;
        return {
          area: A, pct: t.pct, target: target[A],
          reviewAlready: reviewIn[A] || 0, placed: placed[A],
          final: (reviewIn[A] || 0) + placed[A],
          ceiling: (reviewIn[A] || 0) + pickerCount + flexEligible,   // pickers + flex, the honest max
          shortBy: Math.max(0, target[A] - ((reviewIn[A] || 0) + placed[A])),
          over: Math.max(0, ((reviewIn[A] || 0) + placed[A]) - target[A]),  // overage when overflow is on
        };
      }),
      unplaced: assignable.filter(p => p.bucket === "unassigned").length,
    };
  }

  const matrix = {};
  for (const R of REGIONS) matrix[R] = {};
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
    decisions: recs.map(r => ({ user_id: r.user_id, region: r.region, bucket: r.bucket, area: r.area, age: r.age })),
  };
}

module.exports = { allocate, ageAsOf, REGIONS, ALL_AREAS, SPECIAL, ASSIGN_TARGETS };
