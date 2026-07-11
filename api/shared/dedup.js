// Pure duplicate-detection logic for the internal de-dup scan (Build A2). No I/O — unit-tested.
//
// Goal: cluster volunteer records that are likely the SAME human, aggressively (recall over
// precision — a false cluster costs the operator a glance in Build B; a missed duplicate costs a
// double-counted volunteer nobody catches). We deliberately do NOT auto-merge here; A2 only detects
// and reports. Resolution (and the live-BI membership check) happens in Build B via retireInto.
//
// Matching signals, strongest first:
//   - same email (exact, normalized)                          -> high confidence
//   - same phone (normalized last-10, any of cell/home/work)  -> high confidence
//   - fuzzy name (edit-distance OR phonetic) + same JK        -> medium confidence
//   - fuzzy name + different JK                               -> low confidence (relatives vs dup)
// Records are unioned into clusters: if A~B by any signal and B~C by any signal, {A,B,C} is one
// cluster. Each cluster records WHY (the signals that fired) and its risk flags.

const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();
const dig10 = (s) => String(s == null ? "" : s).replace(/\D/g, "").slice(-10);
// Normalize a name for comparison: strip accents, lowercase, drop non-alnum, collapse spaces.
const normName = (first, last) => String((first || "") + " " + (last || ""))
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Levenshtein edit distance (bounded — we only care about small distances).
function editDistance(a, b) {
  a = a || ""; b = b || "";
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;   // too different to matter; short-circuit
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[a.length];
}

// Compact phonetic key so Manji/Manjee, Kassam/Kassim, Aamir/Amir collapse. Not full Metaphone —
// a small, deterministic reduction that folds common Ismaili-name spelling variants:
//   lowercase -> drop vowels after the first char -> collapse doubled letters -> map similar sounds.
function phonetic(s) {
  s = String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "";
  // sound folds applied before vowel-drop
  s = s.replace(/ph/g, "f").replace(/ck/g, "k").replace(/sch/g, "sh")
       .replace(/[kq]/g, "k").replace(/[sz]/g, "s").replace(/y/g, "i");
  const first = s[0];
  let rest = s.slice(1).replace(/[aeiou]/g, "");     // drop interior vowels
  let out = first + rest;
  out = out.replace(/(.)\1+/g, "$1");                // collapse doubled letters
  return out;
}

// Do two names fuzzy-match? Same surname (fuzzy) AND fuzzy-or-phonetic first name is the strong case.
// We also accept a full-string phonetic match (handles transpositions/compound names).
function namesMatch(aFirst, aLast, bFirst, bLast) {
  const af = lc(aFirst), al = lc(aLast), bf = lc(bFirst), bl = lc(bLast);
  if (!(af || al) || !(bf || bl)) return false;
  // exact normalized name
  const an = normName(aFirst, aLast), bn = normName(bFirst, bLast);
  if (an && an === bn) return true;
  // surname must be close (edit<=1 or phonetic-equal); then first name close or phonetic-equal
  const lastClose = al && bl && (editDistance(al, bl) <= 1 || phonetic(al) === phonetic(bl));
  if (lastClose) {
    const firstClose = af && bf && (editDistance(af, bf) <= 1 || phonetic(af) === phonetic(bf));
    if (firstClose) return true;
  }
  // whole-name phonetic equality (catches e.g. slight reorder / compound)
  if (an && bn && phonetic(an.replace(/ /g, "")) === phonetic(bn.replace(/ /g, "")) && phonetic(an.replace(/ /g, ""))) {
    // require at least the surname to be non-trivially similar too, to avoid over-clustering
    if (lastClose) return true;
  }
  return false;
}

// Do two surnames plausibly belong to the same person? (exact, edit<=1, or phonetic-equal)
function surnamesCompatible(a, b) {
  const al = lc(a), bl = lc(b);
  if (!al || !bl) return false;
  return al === bl || editDistance(al, bl) <= 1 || phonetic(al) === phonetic(bl);
}

// Compare a pair of records; return the strongest signal or null.
// KEY RULE: a shared email/phone is only a SAME-PERSON signal when the names are compatible. A shared
// contact with clearly DIFFERENT surnames is a household/shared-line (or, in test data, a coincidental
// collision) — we surface it as a low-confidence "shared_contact_diff_name" hint rather than hard-
// linking, so one shared phone can't transitively chain unrelated people into a mega-cluster.
function pairSignal(a, b) {
  const ae = lc(a.email), be = lc(b.email);
  const emailSame = ae && ae === be;
  const aph = [dig10(a.cell_phone), dig10(a.home_phone), dig10(a.work_phone)].filter(p => p.length === 10);
  const bph = new Set([dig10(b.cell_phone), dig10(b.home_phone), dig10(b.work_phone)].filter(p => p.length === 10));
  const phoneSame = aph.some(p => bph.has(p));

  const nameFuzzy = namesMatch(a.first, a.last, b.first, b.last);
  const surnameOk = surnamesCompatible(a.last, b.last);

  if (emailSame || phoneSame) {
    // Same contact is only SAME-PERSON evidence when the full name is compatible (fuzzy match, which
    // already requires a compatible surname AND first name). Same contact with a compatible surname but
    // a DIFFERENT first name is a household/shared line (siblings, spouses) — or, in synthetic data, a
    // coincidental collision. Either way it is NOT the same person, so we surface it as a non-linking
    // hint rather than chaining a whole family into one cluster.
    if (nameFuzzy) return { signal: emailSame ? "email" : "phone", confidence: "high" };
    return { signal: "shared_contact_diff_name", confidence: "low", link: false };
  }
  if (nameFuzzy) {
    const sameJk = lc(a.ceremony_jk) && lc(a.ceremony_jk) === lc(b.ceremony_jk);
    return sameJk ? { signal: "name_same_jk", confidence: "medium" } : { signal: "name_diff_jk", confidence: "low" };
  }
  return null;
}

// Union-Find.
class UF {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb; }
}

const isAccepted = (v) => !!(v && (v.ivol_ready || lc(v.call_outcome) === "accepted"));
const isWritein = (v) => !!(v && (v.no_bi_account || String(v.user_id).startsWith("wi-")));

// Main entry. records: array of volunteer records (already scoped/region-filtered by the caller).
// Returns { clusters: [...], stats }. Read-only; mutates nothing.
//
// Blocking for scale: comparing all pairs is O(n^2). We block by cheap keys (email, each phone,
// phonetic-surname) and only compare within blocks, then union. This keeps it linear-ish on real data.
function findDuplicateClusters(records, opts = {}) {
  const n = records.length;
  const uf = new UF(n);
  const signalsByEdge = new Map();   // "i|j" -> signal (i<j)
  const hintsByRecord = new Map();   // i -> [{other, signal}]  non-linking hints (shared contact, diff name)
  const recordSignal = (i, j, sig) => {
    if (sig.link === false) {
      // A non-linking hint: surface it on both records but do NOT union.
      (hintsByRecord.get(i) || hintsByRecord.set(i, []).get(i)).push({ other: j, signal: sig.signal });
      (hintsByRecord.get(j) || hintsByRecord.set(j, []).get(j)).push({ other: i, signal: sig.signal });
      return;
    }
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    const prev = signalsByEdge.get(key);
    const rank = { high: 3, medium: 2, low: 1 };
    if (!prev || rank[sig.confidence] > rank[prev.confidence]) signalsByEdge.set(key, sig);
    uf.union(i, j);
  };

  // Build blocks.
  const emailBlocks = new Map();     // email -> [idx]
  const phoneBlocks = new Map();     // phone10 -> [idx]
  const surnameBlocks = new Map();   // phonetic-surname -> [idx]
  records.forEach((v, i) => {
    const e = lc(v.email); if (e) (emailBlocks.get(e) || emailBlocks.set(e, []).get(e)).push(i);
    for (const ph of [dig10(v.cell_phone), dig10(v.home_phone), dig10(v.work_phone)]) {
      if (ph.length === 10) (phoneBlocks.get(ph) || phoneBlocks.set(ph, []).get(ph)).push(i);
    }
    const sk = phonetic(v.last); if (sk) (surnameBlocks.get(sk) || surnameBlocks.set(sk, []).get(sk)).push(i);
  });

  // Compare within each block only.
  const comparePairInBlock = (idxs) => {
    if (idxs.length < 2) return;
    for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) {
      const i = idxs[x], j = idxs[y];
      const sig = pairSignal(records[i], records[j]);
      if (sig) recordSignal(i, j, sig);
    }
  };
  for (const idxs of emailBlocks.values()) comparePairInBlock(idxs);
  for (const idxs of phoneBlocks.values()) comparePairInBlock(idxs);
  for (const idxs of surnameBlocks.values()) comparePairInBlock(idxs);

  // Gather clusters of size >= 2.
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = uf.find(i); (groups.get(r) || groups.set(r, []).get(r)).push(i); }

  const clusters = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const members = idxs.map(i => records[i]);
    const areas = new Set(members.map(m => lc(m.final_area)).filter(Boolean));
    const acceptedMembers = members.filter(isAccepted);
    const acceptedAreas = new Set(acceptedMembers.map(m => lc(m.final_area)).filter(Boolean));
    const numericIds = members.filter(m => !isWritein(m)).map(m => String(m.user_id));
    const writeins = members.filter(isWritein);
    // strongest signal + confidences present in this cluster
    const sigs = [];
    for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) {
      const key = idxs[x] < idxs[y] ? `${idxs[x]}|${idxs[y]}` : `${idxs[y]}|${idxs[x]}`;
      const s = signalsByEdge.get(key); if (s) sigs.push(s);
    }
    const confRank = { high: 3, medium: 2, low: 1 };
    const topConfidence = sigs.reduce((acc, s) => confRank[s.confidence] > confRank[acc] ? s.confidence : acc, "low");
    const signalKinds = [...new Set(sigs.map(s => s.signal))];

    // Disposition category (what A2 can determine without a live BI pull):
    //   accepted_multi_area  -> DANGER: same person accepted in 2+ different areas
    //   needs_bi_check        -> 2+ numeric (BI-sourced) ids; needs a fresh BI pull to know if both
    //                            still exist in BI (both -> BI-team) or one is an orphan (mergeable)
    //   mergeable             -> at most one numeric id (the rest wi-); safe to fold in Build B
    let category;
    if (acceptedAreas.size >= 2) category = "accepted_multi_area";
    else if (numericIds.length >= 2) category = "needs_bi_check";
    else category = "mergeable";

    clusters.push({
      size: members.length,
      category,
      topConfidence,
      signals: signalKinds,
      distinctAreas: [...areas].sort(),
      acceptedCount: acceptedMembers.length,
      acceptedInMultipleAreas: acceptedAreas.size >= 2,
      numericIdCount: numericIds.length,
      writeinCount: writeins.length,
      members: members.map(m => ({
        user_id: m.user_id,
        name: ((m.first || "") + " " + (m.last || "")).trim() || "(no name)",
        region: m.region || "",
        ceremony_jk: m.ceremony_jk || "",
        final_area: m.final_area || "",
        accepted: isAccepted(m),
        assigned_caller: m.assigned_caller || null,
        call_outcome: m.call_outcome || null,
        is_writein: isWritein(m),
        email: m.email || "",
        cell_phone: m.cell_phone || "",
      })),
    });
  }

  // Sort: danger first, then by confidence, then size.
  const catRank = { accepted_multi_area: 3, needs_bi_check: 2, mergeable: 1 };
  const confRank = { high: 3, medium: 2, low: 1 };
  clusters.sort((a, b) =>
    (catRank[b.category] - catRank[a.category]) ||
    (confRank[b.topConfidence] - confRank[a.topConfidence]) ||
    (b.size - a.size));

  const stats = {
    scanned: n,
    clusters: clusters.length,
    duplicateRecords: clusters.reduce((s, c) => s + c.size, 0),
    accepted_multi_area: clusters.filter(c => c.category === "accepted_multi_area").length,
    needs_bi_check: clusters.filter(c => c.category === "needs_bi_check").length,
    mergeable: clusters.filter(c => c.category === "mergeable").length,
  };
  return { clusters, stats };
}

module.exports = { findDuplicateClusters, pairSignal, namesMatch, phonetic, editDistance, normName };
