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
  { area: "Safety & Flow Management",      pct: 0.55, min: 19, max: null },
  { area: "Seniors & Mobility",           pct: 0.14, min: 16, max: null },
  { area: "Reception & Hospitality",      pct: 0.14, min: null, max: null },
  { area: "Environmental Sustainability", pct: 0.02, min: 16, max: 20 },
  { area: "Parking & Transportation",     pct: 0.07, min: 19, max: 65 },
  { area: "Food Services",                pct: 0.04, min: 16, max: null },
  { area: "Layout & Logistics",           pct: 0.04, min: 19, max: 65 },
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
  if (t.min != null) { if (age == null || age < t.min) return false; }
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

  for (const r of recs) {
    if (r.fromReview) {
      if (r.final_area != null) { r.bucket = "affinity"; r.area = r.final_area; }  // stays put
      else { r.bucket = "contested"; r.area = null; }                              // pending, left alone
      continue;
    }
    if (r.isIFF) { r.bucket = "iff"; continue; }          // held aside
    if (r.age == null) { r.bucket = "noage"; continue; }  // held aside (no birthday)
    if (r.age < 16) { r.bucket = "young"; continue; }     // held aside (all under-16)
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
    const place = (p, A) => { p.bucket = "assigned"; p.area = A; placed[A]++; need[A]--; };

    // Pass 1 — happy-to-serve-anywhere people, lowest-% area first, age-gated.
    const happy = shuffle(assignable.filter(p => p.happyAnywhere), rng);
    for (const t of order) {
      const A = t.area; if (need[A] <= 0) continue;
      for (const p of happy) { if (need[A] <= 0) break; if (!p.area && eligible(p.age, tByArea[A])) place(p, A); }
    }
    // Pass 2 — everyone else into one of THEIR picked areas, lowest-% first.
    for (const t of order) {
      const A = t.area; if (need[A] <= 0) continue;
      const pickers = shuffle(assignable.filter(p => !p.area && !p.happyAnywhere && p.prefAreas.indexOf(A) >= 0 && eligible(p.age, tByArea[A])), rng);
      for (const p of pickers) { if (need[A] <= 0) break; place(p, A); }
    }
    // Last resort — people who picked nothing (and aren't happy-anywhere) fill any remaining need.
    for (const t of order) {
      const A = t.area; if (need[A] <= 0) continue;
      const fillers = shuffle(assignable.filter(p => !p.area && !p.happyAnywhere && p.prefAreas.length === 0 && eligible(p.age, tByArea[A])), rng);
      for (const p of fillers) { if (need[A] <= 0) break; place(p, A); }
    }
    // Leftover assignable (no eligible picked area / area full) -> Unassigned.
    for (const p of assignable) if (!p.area) p.bucket = "unassigned";

    distReport[R] = {
      D, reviewFixed: reviewFixed.length, assignable: assignable.length,
      targets: order.map(t => ({
        area: t.area, pct: t.pct, target: target[t.area],
        reviewAlready: reviewIn[t.area] || 0, placed: placed[t.area],
        final: (reviewIn[t.area] || 0) + placed[t.area],
      })),
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
