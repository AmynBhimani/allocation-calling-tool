const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, mergeRegion, REGIONS, readDidars } = require("../shared/store");
const { computeCallableStatus, seedEventAssignments, callerLocked } = require("../shared/status");

const CONN = process.env.RESPONSES_STORAGE;                       // shared volreviewstore account
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const REVIEW_CONTAINER = process.env.RESPONSES_CONTAINER || "reviewer-responses";  // review tool's blobs
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
const JK_OVERRIDES_BLOB = "writein-jk-overrides.json";                             // { match_key: "Ceremony JK" }

// Offline-filled JK corrections for stranded write-ins: match_key -> "Region - Jamatkhana".
async function readJkOverrides() {
  if (!CONN) return {};
  try {
    const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
    const b = c.getBlockBlobClient(JK_OVERRIDES_BLOB);
    if (!(await b.exists())) return {};
    const obj = JSON.parse(await streamToString((await b.download()).readableStreamBody));
    return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
  } catch { return {}; }
}

const AREAS = new Set([
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics", "Registration & Access",
  "Medical Services", "Diverse Abilities Support", "Finance & Procurement", "Environmental Sustainability",
  "Memorabilia & Design", "Jamati Preparation",
]);

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
function streamToString(s) {
  return new Promise((res, rej) => {
    const ch = []; s.on("data", d => ch.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(ch).toString("utf8"))); s.on("error", rej);
  });
}
const normEmail = (e) => String(e || "").toLowerCase().trim();
const normName = (f, l) => (String(f || "") + " " + String(l || "")).toLowerCase().replace(/\s+/g, " ").trim();
// Digits only, last 10 (drops formatting and a leading country code). Fewer than 10 digits = unusable.
const normPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };

// Walk every reviewer blob. Build:
//   byId    : user_id -> { areas:Set, leader:bool }   (people marked active under a BI id)
//   added   : grouped free-form write-ins -> { first,last,email,phone,ceremonyJk, areas:Set }
//             (people a reviewer typed in by hand; no BI id on the entry)
async function aggregateReview() {
  const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(REVIEW_CONTAINER);
  const byId = new Map();
  const addedMap = new Map();
  let reviewerCount = 0, addedRaw = 0;
  if (!(await c.exists())) return { byId, added: [], reviewerCount, addedRaw };
  for await (const item of c.listBlobsFlat()) {
    let blob;
    try { blob = JSON.parse(await streamToString((await c.getBlockBlobClient(item.name).download()).readableStreamBody)); }
    catch { continue; }
    reviewerCount++;
    for (const [key, cell] of Object.entries(blob.cells || {})) {
      const area = String(key).split("|||")[0] || "";
      for (const [vid, v] of Object.entries(cell.volunteers || {})) {
        if (!(v && v.active)) continue;
        let e = byId.get(String(vid));
        if (!e) { e = { areas: new Set(), leader: false }; byId.set(String(vid), e); }
        if (area) e.areas.add(area);
        if (v.leader) e.leader = true;
      }
      for (const a of (cell.added || [])) {
        addedRaw++;
        const em = normEmail(a.email);
        const nm = normName(a.first, a.last);
        const k = em || (nm + "|" + String(a.ceremonyJk || "").toLowerCase().trim());
        if (!k.trim()) continue;
        let e = addedMap.get(k);
        if (!e) { e = { key: k, first: a.first || "", last: a.last || "", email: a.email || "", phone: a.phone || "", ceremonyJk: a.ceremonyJk || "", areas: new Set() }; addedMap.set(k, e); }
        if (area) e.areas.add(area);
      }
    }
  }
  return { byId, added: [...addedMap.values()], reviewerCount, addedRaw };
}

function decisionFor(e) {
  const areas = [...e.areas];
  if (areas.length === 1) return { final_area: areas[0], conflict_claims: [], leader: e.leader };
  if (areas.length >= 2) return { final_area: null, conflict_claims: areas, leader: e.leader };
  return { final_area: null, conflict_claims: [], leader: e.leader };
}

// Region is taken from the Jamatkhana prefix the reviewer entered ("BC - Burnaby Lake" -> "BC").
function regionFromJk(jk) {
  const s = String(jk || "").trim();
  const pre = s.split(/\s*-\s*/)[0].trim();
  if (REGIONS.includes(pre)) return pre;
  if (REGIONS.includes(s)) return s;
  return null;
}
const safeKey = (k) => "wi-" + String(k).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

// Build a brand-new, callable No-BI record for a written-in person (no Better Impact id).
function makeWriteinRecord(a, didars) {
  const dec = decisionFor({ areas: a.areas, leader: false });
  const region = regionFromJk(a.ceremonyJk);
  const cands = (a.candidates || []);
  const base = {
    user_id: safeKey(a.key), first: a.first || "", last: a.last || "", email: a.email || "",
    username: "", cell_phone: a.phone || "", home_phone: "", work_phone: "",
    ceremony_jk: a.ceremonyJk || "", region,
    computed_area: dec.final_area || (dec.conflict_claims[0] || null),
    final_area: dec.final_area, conflict_claims: dec.conflict_claims,
    held_aside: false, affinity_flag: false, leader_flag: false,
    never_reviewed: false, new_since_sync: false,
    no_bi_account: true, source: "writein",
    potential_duplicate: cands.length
      ? { candidates: cands.slice(0, 3).map(c => ({ user_id: c.user_id, region: c.region, email: c.email || "", name: c.name || "" })) }
      : null,
    assigned_caller: null, ivol_entered: false, ivol_ready: false,
    call_outcome: null, call_done: false, referred_from: null,
    activity_log: [{ ts: new Date().toISOString(), actor: "transfer", action: "writein_import", areas: [...a.areas] }],
  };
  base.callable_status = computeCallableStatus(base);
  base.event_assignments = base.final_area ? seedEventAssignments(base, didars) : [];
  return base;
}

// Per-volunteer migration logic, extracted so it can be unit-tested directly. `ctx` carries the
// state the handler builds: { byId, report, seenIds, idInfo, commit, email, didars }.
// Behavior is identical to the inline version; the handler calls it once per existing record.
function applyMigration(v, ctx) {
  const { byId, report, seenIds, idInfo, commit, email, didars } = ctx;
  if (v.released_to_pool) return v;   // deliberately released to the pool; never re-hold from review
  // Match the review decision by this person's current id OR any id merged INTO them. Dedup and the
  // write-in -> BI promotion can leave a reviewer's area keyed to an id that no longer exists as its own
  // record; without also checking merged_from, the survivor who absorbed that id would come through the
  // migration still area-less. Union the areas found under all of this person's ids.
  const matchIds = [String(v.user_id), ...(Array.isArray(v.merged_from) ? v.merged_from.map(String) : [])];
  let e = null;
  for (const mid of matchIds) {
    const hit = byId.get(mid);
    if (!hit) continue;
    if (!e) e = { areas: new Set(), leader: false };
    for (const a of hit.areas) e.areas.add(a);
    if (hit.leader) e.leader = true;
    seenIds.add(mid);                 // this review id maps to a real (surviving) person; not "unmatched"
  }
  if (!e) return v;                   // no review entry under any of this person's ids; leave them as-is
  const d = decisionFor(e);

  // Never let a migration DISTURB anyone already on a caller's list or called/accepted/confirmed — with
  // ONE exception: if they have no area yet, fill in the single area a reviewer picked. That only sets
  // their area (it can't pull an accepted person — who already HAS an area — back into reconciliation),
  // and it's exactly what a caller needs to work them. A contested (2+ area) review still defers.
  const hasArea = !!String(v.final_area || "").trim();
  const fillAreaOnly = !hasArea && !!d.final_area;    // no area here + one reviewed area to apply
  if ((callerLocked(v) || v.assigned_caller) && !fillAreaOnly) {
    report.protectedLocked++;
    if (report.protectedLockedList.length < 300) {
      const info = idInfo.get(String(v.user_id)) || {};
      report.protectedLockedList.push({ user_id: v.user_id, name: ((v.first || "") + " " + (v.last || "")).trim() || info.name || "", region: v.region || info.region || "", area: v.final_area || null });
    }
    return v;
  }

  report.matched++;
  if (d.final_area) report.toStable++;
  else if (d.conflict_claims.length >= 2) report.toReconciliation++;
  else report.noArea++;
  if (d.leader) report.leaders++;

  const wasCalled = !!v.assigned_caller || !!v.call_done || !!v.call_outcome || !!v.ivol_ready || !!v.ivol_entered;
  const reviewedReferral = wasCalled && !!d.final_area && !!v.final_area && d.final_area !== v.final_area;
  if (reviewedReferral) {
    report.reviewedReferrals++;
    if (report.reviewedReferralList.length < 300) {
      const info = idInfo.get(String(v.user_id)) || {};
      report.reviewedReferralList.push({ user_id: v.user_id, name: ((v.first || "") + " " + (v.last || "")).trim() || info.name || "", region: v.region || info.region || "", from: v.final_area, to: d.final_area });
    }
  }

  if (!commit) return v;
  const nv = { ...v };
  nv.conflict_claims = d.conflict_claims;
  nv.leader_flag = d.leader || !!nv.leader_flag;
  nv.never_reviewed = false;
  nv.activity_log = nv.activity_log || [];

  if (reviewedReferral) {
    nv.referred_from = v.final_area;
    nv.final_area = d.final_area;
    nv.assigned_caller = null;            // receiving area's quarterback reassigns
    nv.call_done = false;                 // back in the active calling queue
    nv.call_outcome = null;
    nv.ivol_ready = false;
    nv.confirm_token = null; nv.confirm_sent_at = null; nv.confirmed_at = null;
    if (v.ivol_entered) nv.bi_correction_needed = true;   // was entered in BI under the old area
    nv.referral_reason = "Reopened after a new affinity review.";
    nv.event_assignments = seedEventAssignments({ ...nv, event_assignments: [] }, didars); // fresh rows for the new area; old-area captures dropped
    nv.callable_status = computeCallableStatus(nv);
    nv.activity_log.push({ ts: new Date().toISOString(), actor: email || "transfer",
      action: "reviewed_referral", from: nv.referred_from, to: nv.final_area, note: nv.referral_reason });
    return nv;
  }

  nv.final_area = d.final_area;
  nv.callable_status = computeCallableStatus(nv);
  if (nv.final_area) nv.event_assignments = seedEventAssignments(nv, didars);
  nv.activity_log.push({ ts: new Date().toISOString(), actor: email || "transfer",
    action: "transfer_reconcile", to: nv.final_area || null, claims: d.conflict_claims.length });
  return nv;
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = (principal && principal.userDetails) || "";
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const { byId, added, reviewerCount, addedRaw } = await aggregateReview();

    // Apply offline-filled JK corrections: a stranded write-in (no JK) whose match_key has an override
    // inherits that Jamatkhana, so it places normally on this run instead of stranding again.
    const jkOverrides = await readJkOverrides();
    let jkOverridesApplied = 0;
    for (const a of added) {
      if (!String(a.ceremonyJk || "").trim() && jkOverrides[a.key]) { a.ceremonyJk = jkOverrides[a.key]; jkOverridesApplied++; }
    }
    const didars = await readDidars();
    const container = await getContainer(DATA_CONTAINER);
    const commit = req.method === "POST" && (req.body || {}).mode === "commit";

    // Pre-pass: read all shards once to index the workspace by email and by name.
    const emailIndex = new Map();   // normEmail -> { region, user_id, name }
    const nameIndex = new Map();    // normName  -> [ { region, user_id, email } ]
    const phoneIndex = new Map();   // normPhone -> [ { region, user_id, email, name } ]  (cell/home/work)
    const idInfo = new Map();       // user_id   -> { name, region }
    const recordsByRegion = {};
    for (const region of REGIONS) {
      const { records } = await readRegion(container, region);
      recordsByRegion[region] = records;
      for (const v of records) {
        idInfo.set(String(v.user_id), { name: ((v.first || "") + " " + (v.last || "")).trim(), region });
        // Skip records this tool imported on a previous transfer commit (written-in No-BI people).
        // Otherwise a write-in re-matches its own imported copy by email/name on the next run, which
        // would re-fold it and make the reviewed/contested counts creep up on every commit cycle.
        if (v.source === "writein" || String(v.user_id).startsWith("wi-")) continue;
        const em = normEmail(v.email);
        if (em && !emailIndex.has(em)) emailIndex.set(em, { region, user_id: v.user_id, name: ((v.first || "") + " " + (v.last || "")).trim() });
        const nm = normName(v.first, v.last);
        if (nm) { if (!nameIndex.has(nm)) nameIndex.set(nm, []); nameIndex.get(nm).push({ region, user_id: v.user_id, email: v.email || "", name: ((v.first || "") + " " + (v.last || "")).trim() }); }
        const seenPh = new Set();   // don't index the same number twice for one person (e.g. cell === home)
        for (const ph of [normPhone(v.cell_phone), normPhone(v.home_phone), normPhone(v.work_phone)]) {
          if (!ph || seenPh.has(ph)) continue;
          seenPh.add(ph);
          if (!phoneIndex.has(ph)) phoneIndex.set(ph, []);
          phoneIndex.get(ph).push({ region, user_id: v.user_id, email: v.email || "", name: ((v.first || "") + " " + (v.last || "")).trim() });
        }
      }
    }

    // Read-only audit (?audit=1): who did a PRIOR (pre-guard) migration disturb while they were on a
    // caller's list or called/accepted? Returns them without running any migration.
    if (req.query && req.query.audit === "1") {
      const lockedNow = (v) => callerLocked(v) || !!v.assigned_caller;
      const nm = (v) => ((v.first || "") + " " + (v.last || "")).trim();
      const inReconciliation = [], reopenedByReferral = [];
      for (const region of REGIONS) {
        for (const v of (recordsByRegion[region] || [])) {
          const claims = Array.isArray(v.conflict_claims) ? v.conflict_claims : [];
          const contested = v.callable_status === "In reconciliation" || claims.length >= 2;
          if (contested && lockedNow(v)) {
            inReconciliation.push({ user_id: v.user_id, name: nm(v), region, jk: v.ceremony_jk || "",
              signal: v.assigned_caller ? "on a caller's list" : (v.ivol_ready ? "accepted" : "called"),
              assigned_caller: v.assigned_caller || null, claims });
          }
          const ref = (v.activity_log || []).filter(e => e && e.action === "reviewed_referral").slice(-1)[0];
          if (ref) reopenedByReferral.push({ user_id: v.user_id, name: nm(v), region, jk: v.ceremony_jk || "", from: ref.from || null, to: ref.to || null, when: ref.ts || null });
        }
      }
      const bySort = (a, b) => (a.region + a.name).localeCompare(b.region + b.name);
      inReconciliation.sort(bySort); reopenedByReferral.sort(bySort);
      context.res = { body: {
        note: "People a prior migration disturbed while called or on a caller's list. inReconciliation = knocked into reconciliation (fix: set their final area back on the Reconcile screen, which clears the conflict). reopenedByReferral = moved to a new area with their caller cleared (fix: reassign, or restore from the pre-migration backup).",
        inReconciliationCount: inReconciliation.length, inReconciliation: inReconciliation.slice(0, 2000),
        reopenedByReferralCount: reopenedByReferral.length, reopenedByReferral: reopenedByReferral.slice(0, 2000),
      } };
      return;
    }
    //  - email match  -> fold their area(s) into the existing record (no duplicate created)
    //  - everyone else -> import as a brand-new callable No-BI record, flagged "potential duplicate"
    //                     when their name matches an existing person (caller confirms on the call)
    const writeins = [];
    const writeinContested = [];   // imported write-ins claimed in 2+ areas (also land "In reconciliation")
    const reviewActiveRaw = byId.size;   // people marked active in review cells, BEFORE folding write-ins
    let addedByEmail = 0, addedImported = 0, addedDuplicateFlagged = 0, addedNoRegion = 0, emailFoldedNew = 0;
    let addedByName = 0;
    let addedByPhone = 0;
    const resolvedByName = [];       // JK-less write-ins folded into a UNIQUE existing person by name
    const ambiguousNameMatch = [];   // JK-less write-ins whose name matched 2+ people — left for a human
    const resolvedByPhone = [];      // JK-less write-ins folded into a UNIQUE existing person by phone
    const ambiguousPhoneMatch = [];  // JK-less write-ins whose phone matched 2+ people (shared line)
    const strandedList = [];         // JK-less write-ins with NO match anywhere — the exportable list
    for (const a of added) {
      const em = normEmail(a.email);
      if (em && emailIndex.has(em)) {
        const w = emailIndex.get(em);
        let e = byId.get(String(w.user_id));
        if (!e) { e = { areas: new Set(), leader: false }; byId.set(String(w.user_id), e); emailFoldedNew++; } // a person not separately marked active
        for (const ar of a.areas) e.areas.add(ar);
        addedByEmail++;
        continue;
      }
      const region = regionFromJk(a.ceremonyJk);
      if (!region) {
        // No usable JK to place them on their own. Before leaving them hanging, see if they already
        // exist in the allocation tool under a recognized JK. Fold in ONLY on a unique match — that
        // inherits their JK/region and avoids creating a JK-less record. Try phone, then name.
        // 1) Phone (cell/home/work). Strong signal, but a shared household line can hit 2+ people,
        //    so we only fold on a unique match and surface shared-line hits for a human.
        const ph = normPhone(a.phone);
        if (ph) {
          const raw = phoneIndex.get(ph) || [];
          const ids = [...new Set(raw.map(c => String(c.user_id)))];   // distinct people, not index entries
          if (ids.length === 1) {
            const w = raw.find(c => String(c.user_id) === ids[0]);
            let e = byId.get(String(w.user_id));
            if (!e) { e = { areas: new Set(), leader: false }; byId.set(String(w.user_id), e); emailFoldedNew++; }
            for (const ar of a.areas) e.areas.add(ar);
            addedByPhone++;
            resolvedByPhone.push({ name: ((a.first || "") + " " + (a.last || "")).trim(), areas: [...a.areas].sort(),
              matched_user_id: w.user_id, region: w.region, matched_name: w.name || "" });
            continue;
          }
          if (ids.length >= 2) {
            ambiguousPhoneMatch.push({ name: ((a.first || "") + " " + (a.last || "")).trim(), areas: [...a.areas].sort(),
              candidates: raw.filter((c, i, arr) => arr.findIndex(x => String(x.user_id) === String(c.user_id)) === i).slice(0, 5).map(c => ({ user_id: c.user_id, region: c.region, name: c.name || "" })) });
          }
        }
        // 2) Unique name match.
        const nmz = normName(a.first, a.last);
        const cands = nmz ? (nameIndex.get(nmz) || []) : [];
        if (cands.length === 1) {
          const w = cands[0];
          let e = byId.get(String(w.user_id));
          if (!e) { e = { areas: new Set(), leader: false }; byId.set(String(w.user_id), e); emailFoldedNew++; }
          for (const ar of a.areas) e.areas.add(ar);
          addedByName++;
          resolvedByName.push({ name: ((a.first || "") + " " + (a.last || "")).trim(), areas: [...a.areas].sort(),
            matched_user_id: w.user_id, region: w.region, matched_email: w.email || "" });
          continue;
        }
        if (cands.length >= 2) {
          ambiguousNameMatch.push({ name: ((a.first || "") + " " + (a.last || "")).trim(), areas: [...a.areas].sort(),
            candidates: cands.slice(0, 5).map(c => ({ user_id: c.user_id, region: c.region, email: c.email || "" })) });
        }
        // Truly stranded: no JK, and no email/phone/name match. Capture with its stable key so the JK
        // can be filled in offline and re-imported (the key round-trips through the override table).
        if (strandedList.length < 5000) {
          strandedList.push({ match_key: a.key, first: a.first || "", last: a.last || "", email: a.email || "",
            phone: a.phone || "", areas: [...a.areas].sort() });
        }
        addedNoRegion++;     // still can't place: no JK, no email match, and no unique name match
        continue;
      }
      const nm = normName(a.first, a.last);
      a.candidates = nm ? (nameIndex.get(nm) || []) : [];   // consumed by makeWriteinRecord for the dup flag
      const rec = makeWriteinRecord(a, didars);
      writeins.push({ region, record: rec });
      addedImported++;
      if (a.candidates.length) addedDuplicateFlagged++;
      if ((rec.conflict_claims || []).length >= 2) {
        writeinContested.push({ user_id: rec.user_id, name: ((rec.first || "") + " " + (rec.last || "")).trim(), region, areas: [...rec.conflict_claims].sort(), source: "writein" });
      }
    }
    const writeinsByRegion = {};
    for (const w of writeins) (writeinsByRegion[w.region] = writeinsByRegion[w.region] || []).push(w.record);

    // The people who will land "In reconciliation": claimed in 2+ distinct areas, no single winner.
    // This includes reviewed/matched people (from byId) AND imported write-ins claimed in 2+ areas,
    // so the total matches what shows on the Reconcile page.
    const contestedList = [];
    for (const [id, e] of byId) {
      if (e.areas && e.areas.size >= 2) {
        const info = idInfo.get(String(id)) || {};
        contestedList.push({ user_id: id, name: info.name || "", region: info.region || "", areas: [...e.areas].sort(), source: "review" });
      }
    }
    const reviewContested = contestedList.length;
    for (const w of writeinContested) contestedList.push(w);
    contestedList.sort((a, b) => (a.region + a.name).localeCompare(b.region + b.name));

    const report = {
      mode: commit ? "commit" : "preview",
      reviewerBlobs: reviewerCount, reviewActiveIds: byId.size,
      reviewActiveRaw, emailFoldedNew, contestedList: contestedList.slice(0, 300),
      writtenInContested: writeinContested.length, reconcileTotal: reviewContested + writeinContested.length,
      matched: 0, toStable: 0, toReconciliation: 0, leaders: 0, noArea: 0,
      reviewedReferrals: 0, reviewedReferralList: [],
      protectedLocked: 0, protectedLockedList: [],
      reviewIdsNotInWorkspace: 0, unknownAreas: [], byRegion: {},
      writtenIn: { total: added.length, rawEntries: addedRaw, matchedByEmail: addedByEmail,
        matchedByName: addedByName, matchedByPhone: addedByPhone, imported: addedImported, duplicateFlagged: addedDuplicateFlagged, noRegion: addedNoRegion },
      resolvedByName: resolvedByName.slice(0, 300), resolvedByNameCount: resolvedByName.length,
      ambiguousNameMatch: ambiguousNameMatch.slice(0, 300), ambiguousNameMatchCount: ambiguousNameMatch.length,
      resolvedByPhone: resolvedByPhone.slice(0, 300), resolvedByPhoneCount: resolvedByPhone.length,
      ambiguousPhoneMatch: ambiguousPhoneMatch.slice(0, 300), ambiguousPhoneMatchCount: ambiguousPhoneMatch.length,
      strandedList: strandedList.slice(0, 5000), strandedCount: strandedList.length,
      jkOverridesApplied,
    };
    const unknown = new Set();
    for (const [, e] of byId) for (const a of e.areas) if (!AREAS.has(a)) unknown.add(a);
    report.unknownAreas = [...unknown];

    const seenIds = new Set();
    const applyTo = (v) => applyMigration(v, { byId, report, seenIds, idInfo, commit, email, didars });

    // A write-in that was migrated on a PRIOR run and has since been merged away by retireInto (into a
    // real BI account, or into another record) no longer exists under its wi- id — but retireInto left
    // that id in the survivor's merged_from. Without checking merged_from we would re-create the wi-
    // record on every run, endlessly resurrecting a duplicate the operator already resolved. So the
    // "already present" test is: current ids UNION every id ever folded into a surviving record.
    // NOTE: this only guards wi- record RE-CREATION (the push below). The email/phone/name FOLD paths
    // upstream are untouched, so stranded-volunteer recovery still runs on every migration.
    const mergedAwayIds = (records) => {
      const s = new Set();
      for (const v of records) for (const id of (Array.isArray(v.merged_from) ? v.merged_from : [])) s.add(String(id));
      return s;
    };

    for (const region of REGIONS) {
      const newOnes = writeinsByRegion[region] || [];
      if (commit) {
        const out = await mergeRegion(container, region, (existing) => {
          const mapped = existing.map(applyTo);
          const have = new Set(mapped.map(v => String(v.user_id)));
          const gone = mergedAwayIds(existing);   // ids already migrated then merged away
          for (const w of newOnes) {
            const wid = String(w.user_id);
            if (!have.has(wid) && !gone.has(wid)) mapped.push(w);   // idempotent upsert, merge-aware
          }
          return mapped;
        });
        report.byRegion[region] = out.length;
      } else {
        const existing = recordsByRegion[region] || [];
        existing.forEach(applyTo);
        const have = new Set(existing.map(v => String(v.user_id)));
        const gone = mergedAwayIds(existing);
        const fresh = newOnes.filter(w => { const wid = String(w.user_id); return !have.has(wid) && !gone.has(wid); }).length;
        report.byRegion[region] = existing.length + fresh;
      }
    }
    report.reviewIdsNotInWorkspace = [...byId.keys()].filter(id => !seenIds.has(id)).length;
    report.note = commit
      ? "Applied. Email-matched write-ins folded into existing records. Everyone else written in was imported as a callable No-BI record; name matches carry a 'potential duplicate' flag for the caller to resolve on the call."
      : "Preview only — nothing written. Shows what would be folded by email vs imported as No-BI (with potential-duplicate flags) vs un-placeable by region.";
    context.res = { body: report };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};

module.exports.applyMigration = applyMigration;
module.exports.decisionFor = decisionFor;
