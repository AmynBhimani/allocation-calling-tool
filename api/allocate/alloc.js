// Bulk allocation engine — pure function over stored volunteer records.
// Deterministic given the same records + seed, so a preview and a later commit
// with the same seed produce the identical plan.
//
// Input record (from a tool-data shard):
//   { user_id, region, computed_area, final_area, never_reviewed, leader_flag,
//     list, interfaith, birthday }
// "Affinity" = anyone already assigned an area through the review-tool load
// (final_area != null). They keep their area untouched.

const REGIONS = ["BC", "Prairies", "Edmonton"];

// The 12 canonical service areas, for stable display ordering.
const ALL_AREAS = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics", "Registration & Access",
  "Medical Services", "Finance & Procurement", "Environmental Sustainability",
  "Memorabilia & Design", "Jamati Preparation",
];
const SPECIAL = ["Young Volunteers", "IFF", "Unassigned"];

// Distribution targets for the over-16 Unassigned pool. Percentages are of that pool.
// min/max are hard age gates. SSP = Safety & Flow Management.
const ASSIGN_TARGETS = [
  { area: "Safety & Flow Management",      pct: 0.55, min: 19, max: null },
  { area: "Seniors & Mobility",           pct: 0.14, min: 16, max: null },
  { area: "Reception & Hospitality",      pct: 0.14, min: null, max: null },
  { area: "Environmental Sustainability", pct: 0.02, min: 16, max: 20 },
  { area: "Parking & Transportation",     pct: 0.07, min: 19, max: 65 },
  { area: "Food Services",                pct: 0.04, min: 16, max: null },
  { area: "Layout & Logistics",           pct: 0.04, min: 19, max: 65 },
];
// Fill most age-restrictive areas first so a narrow eligibility pool isn't consumed
// by an unrestricted area.
const FILL_ORDER = [
  "Environmental Sustainability", "Parking & Transportation", "Layout & Logistics",
  "Safety & Flow Management", "Seniors & Mobility", "Food Services", "Reception & Hospitality",
];

// Per-region random removals into Unassigned (editable in the UI; these are the defaults).
const DEFAULT_STRIP = {
  BC:       { "Food Services": 150, "Reception & Hospitality": 400 },
  Edmonton: { "Reception & Hospitality": 400, "Food Services": 300 },
  Prairies: { "Reception & Hospitality": 400, "Food Services": 300 },
};

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
  if (t.min != null) { if (age == null || age < t.min) return false; }
  if (t.max != null) { if (age == null || age > t.max) return false; }
  return true;
}

function allocate(records, cfg) {
  cfg = cfg || {};
  const asOf = cfg.asOf || "2026-07-23";
  const seed = (cfg.seed != null ? cfg.seed : 1234567) >>> 0;
  const strip = cfg.strip || DEFAULT_STRIP;
  const rng = mulberry32(seed);

  // Annotate every record and assign an initial bucket.
  const recs = records.map(r => {
    const directAge = (r.age != null && Number.isFinite(Number(r.age))) ? Number(r.age) : null;
    return {
      user_id: r.user_id, region: r.region,
      computed_area: r.computed_area || null, final_area: r.final_area || null,
      leader: !!r.leader_flag,
      age: directAge != null ? directAge : ageAsOf(r.birthday, asOf),
      isIFF: (r.list === "IFF") || !!r.interfaith,
      affinity: r.final_area != null,
      bucket: null, area: null,
    };
  });

  for (const r of recs) {
    if (r.affinity) { r.bucket = "affinity"; r.area = r.final_area; continue; }
    if (r.isIFF) { r.bucket = "iff"; r.area = null; continue; }            // IFF out of all process areas
    const area = r.computed_area;
    if (r.age != null && r.age < 16) {                                     // under-16 stripped...
      if (area === "Reception & Hospitality") { r.bucket = "kept"; r.area = area; } // ...except R&H
      else { r.bucket = "young"; r.area = null; }
      continue;
    }
    if (area) { r.bucket = "kept"; r.area = area; }
    else { r.bucket = "unassigned"; r.area = null; }                       // no computed area -> pool
  }

  // Random per-region removals from the kept Food / Reception pools into Unassigned.
  const stripReport = {};
  for (const R of REGIONS) {
    stripReport[R] = {};
    const cfgR = strip[R] || {};
    for (const A of Object.keys(cfgR)) {
      const want = cfgR[A] | 0;
      const pool = recs.filter(x => x.region === R && x.bucket === "kept" && x.area === A && !(x.age != null && x.age < 16));
      const sh = shuffle(pool, rng);
      const take = Math.max(0, Math.min(want, sh.length));
      for (let i = 0; i < take; i++) { sh[i].bucket = "unassigned"; sh[i].area = null; }
      stripReport[R][A] = { requested: want, removed: take, available: pool.length };
    }
  }

  // Phase B: re-bucket the Unassigned pool, then distribute the over-16 non-IFF remainder.
  for (const r of recs) {
    if (r.bucket !== "unassigned") continue;
    if (r.isIFF) { r.bucket = "iff"; continue; }
    if (r.age != null && r.age < 16) { r.bucket = "young"; continue; }     // leave under-16 as Young
    // null age or 16+ stays "unassigned" for now; only 16+ get distributed
  }

  const distReport = {};
  for (const R of REGIONS) {
    const pool = recs.filter(x => x.region === R && x.bucket === "unassigned" && x.age != null && x.age >= 16 && !x.isIFF);
    const N = pool.length;
    const targets = ASSIGN_TARGETS.map(t => ({ ...t, target: Math.round(t.pct * N), placed: 0 }));
    const tByArea = {}; targets.forEach(t => (tByArea[t.area] = t));
    let remaining = shuffle(pool, rng);
    const used = new Set();
    for (const A of FILL_ORDER) {
      const t = tByArea[A];
      for (const p of remaining) {
        if (t.placed >= t.target) break;
        if (eligible(p.age, t)) { p.bucket = "assigned"; p.area = A; used.add(p.user_id); t.placed++; }
      }
      remaining = remaining.filter(p => !used.has(p.user_id));
    }
    distReport[R] = {
      poolOver16: N,
      targets: targets.map(t => ({ area: t.area, pct: t.pct, target: t.target, placed: t.placed })),
      unplaced: remaining.length,
    };
  }

  // Region x area matrix (final placement counts).
  const matrix = {};
  for (const R of REGIONS) matrix[R] = {};
  for (const r of recs) {
    const R = r.region; if (!matrix[R]) matrix[R] = {};
    let key;
    if (r.bucket === "affinity" || r.bucket === "kept" || r.bucket === "assigned") key = r.area || "Unassigned";
    else if (r.bucket === "young") key = "Young Volunteers";
    else if (r.bucket === "iff") key = "IFF";
    else key = "Unassigned";
    matrix[R][key] = (matrix[R][key] || 0) + 1;
  }

  const affinityTotal = recs.filter(r => r.bucket === "affinity").length;
  const affinityLeaders = recs.filter(r => r.bucket === "affinity" && r.leader).length;
  const nullAge = recs.filter(r => r.age == null).length;

  return {
    asOf, seed, matrix, affinityTotal, affinityLeaders, nullAge,
    stripReport, distReport,
    decisions: recs.map(r => ({ user_id: r.user_id, region: r.region, bucket: r.bucket, area: r.area })),
  };
}

module.exports = { allocate, ageAsOf, REGIONS, ALL_AREAS, SPECIAL, ASSIGN_TARGETS, DEFAULT_STRIP };
