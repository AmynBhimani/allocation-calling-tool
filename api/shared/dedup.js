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

// Derive age identically to the rest of the tool (all-volunteers / volunteer endpoints): stored `age`
// wins, else compute from `birthday`, else null. ~98% of real records have this, so it's a reliable
// disambiguator — two records that "match" on name/email but differ sharply in age are different people.
function ageOf(v) {
  if (v.age != null && Number.isFinite(Number(v.age))) return Number(v.age);
  if (!v.birthday) return null;
  const d = new Date(v.birthday); if (isNaN(d)) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 130 ? a : null;
}
// How far apart are two records in age? null if either lacks age (then age can't gate the match).
function ageGap(a, b) {
  const aa = ageOf(a), ab = ageOf(b);
  if (aa == null || ab == null) return null;
  return Math.abs(aa - ab);
}
// A real duplicate is the same person, so ages match within a birthday's slop. Beyond this, different
// people (parent/child sharing an email, two same-named relatives). 3 tolerates stale/mis-keyed data.
const AGE_SPLIT_THRESHOLD = 3;
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
  // Surname must be close; then the FIRST name must be a genuine spelling variant, not merely one edit
  // away. Single-letter SUBSTITUTIONS on short first names are almost always DIFFERENT people in this
  // community (Zahra/Zuhra/Zahir, Amin/Amir, Nadia/Nadir), so edit<=1 is far too loose. We only accept:
  //   - identical first names, OR
  //   - a variant explained by insertion/deletion of a repeated letter (Aamir/Amir, Nurin/Nuurin), i.e.
  //     the shorter collapses into the longer, OR
  //   - phonetic-equal where that equality is NOT produced by swapping a single distinguishing letter.
  const lastClose = al && bl && (editDistance(al, bl) <= 1 || phonetic(al) === phonetic(bl));
  if (lastClose && af && bf && firstNamesSamePerson(af, bf)) return true;
  return false;
}

// Collapse a name to its "shape" for repeated-letter comparison: lowercase, drop non-letters,
// collapse any run of the same letter to one. Aamir->amir, Amir->amir (match). Zahra->zahra,
// Zahir->zahir (NO match — different letters, not a repeat).
const collapseRepeats = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");

// Are two FIRST names the same person's name (identical or a safe spelling variant)?
function firstNamesSamePerson(a, b) {
  a = lc(a); b = lc(b);
  if (!a || !b) return false;
  if (a === b) return true;
  // variant only if they collapse to the SAME letter-sequence once repeated letters are removed.
  // This accepts Aamir/Amir and Muhammad/Muhamad, but rejects Zahra/Zuhra and Zahra/Zahir (their
  // collapsed forms still differ). This is the key guard against short-name over-matching.
  if (collapseRepeats(a) === collapseRepeats(b) && collapseRepeats(a).length >= 2) return true;
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

  // Age gate: if a match is otherwise indicated but ages differ sharply, these are different people
  // (parent/child on a shared email, same-named relatives) — downgrade to a non-linking hint. When
  // either record lacks age (~2%), the gate is inactive and matching falls back to name/contact.
  const gap = ageGap(a, b);
  const ageSplits = gap != null && gap > AGE_SPLIT_THRESHOLD;   // strong evidence of DIFFERENT people
  const ageTight = gap != null && gap <= 1;                      // strong evidence of SAME person

  if (emailSame || phoneSame) {
    // Same contact is same-person evidence only when the name is compatible AND age doesn't contradict.
    if (nameFuzzy && !ageSplits) return { signal: emailSame ? "email" : "phone", confidence: "high" };
    // Same contact but names differ, OR a large age gap -> household/family/relatives; hint, no link.
    return { signal: ageSplits ? "shared_contact_age_gap" : "shared_contact_diff_name", confidence: "low", link: false };
  }
  if (nameFuzzy) {
    // A large age gap splits even a same-name+JK pair (two same-named relatives at one JK).
    if (ageSplits) return { signal: "same_name_age_gap", confidence: "low", link: false };
    const sameJk = lc(a.ceremony_jk) && lc(a.ceremony_jk) === lc(b.ceremony_jk);
    if (sameJk) return { signal: "name_same_jk", confidence: ageTight ? "high" : "medium" };
    // Same name, different JK: normally a non-linking hint (could be relatives). But if age is TIGHT,
    // it's more likely one person who moved / attends two JKs, so we allow a medium link.
    return ageTight
      ? { signal: "name_diff_jk_age_match", confidence: "medium" }
      : { signal: "name_diff_jk", confidence: "low", link: false };
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
  // Pairs a human has declared to be two different people (shared/distinct.js). Keyed by user_id, not
  // index, because index is an artefact of read order. Suppression has to happen HERE, at the edge,
  // not on the finished cluster: clusters are union-find, so A-B and B-C collapse into {A,B,C} and
  // dropping the group would throw away a real B-C duplicate along with the false A-B one. Declining
  // the union instead lets the cluster split correctly at any size.
  const declaredDistinct = opts.distinctPairs instanceof Set ? opts.distinctPairs : null;
  const distinctKey = (i, j) => {
    const x = String(records[i] && records[i].user_id), y = String(records[j] && records[j].user_id);
    return x < y ? `${x}|${y}` : `${y}|${x}`;
  };
  const recordSignal = (i, j, sig) => {
    // A declaration outranks every heuristic — a human checked Better Impact, the scan only guessed.
    // Demote to a non-linking hint rather than dropping it: the signal is real and still worth
    // showing, it just doesn't mean "same person" for this pair.
    if (declaredDistinct && declaredDistinct.has(distinctKey(i, j))) {
      sig = { ...sig, signal: sig.signal, confidence: "low", link: false, declaredDistinct: true };
    }
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
        age: ageOf(m),
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

module.exports = { findDuplicateClusters, pairSignal, namesMatch, phonetic, editDistance, normName, firstNamesSamePerson };
