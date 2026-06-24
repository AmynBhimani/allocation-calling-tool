const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, readRegion, mergeRegion, REGIONS, readDidars } = require("../shared/store");
const { computeCallableStatus, seedEventAssignments } = require("../shared/status");

const CONN = process.env.RESPONSES_STORAGE;                       // shared volreviewstore account
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const REVIEW_CONTAINER = process.env.RESPONSES_CONTAINER || "reviewer-responses";  // review tool's blobs

const AREAS = new Set([
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics", "Registration & Access",
  "Medical Services", "Finance & Procurement", "Environmental Sustainability",
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

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = (principal && principal.userDetails) || "";
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const { byId, added, reviewerCount, addedRaw } = await aggregateReview();
    const didars = await readDidars();
    const container = await getContainer(DATA_CONTAINER);
    const commit = req.method === "POST" && (req.body || {}).mode === "commit";

    // Pre-pass: read all shards once to index the workspace by email and by name.
    const emailIndex = new Map();   // normEmail -> { region, user_id, name }
    const nameIndex = new Map();    // normName  -> [ { region, user_id, email } ]
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
      }
    }

    // Resolve the write-ins:
    //  - email match  -> fold their area(s) into the existing record (no duplicate created)
    //  - everyone else -> import as a brand-new callable No-BI record, flagged "potential duplicate"
    //                     when their name matches an existing person (caller confirms on the call)
    const writeins = [];
    const writeinContested = [];   // imported write-ins claimed in 2+ areas (also land "In reconciliation")
    const reviewActiveRaw = byId.size;   // people marked active in review cells, BEFORE folding write-ins
    let addedByEmail = 0, addedImported = 0, addedDuplicateFlagged = 0, addedNoRegion = 0, emailFoldedNew = 0;
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
      if (!region) { addedNoRegion++; continue; }     // can't place without a region — reported, not imported
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
      reviewIdsNotInWorkspace: 0, unknownAreas: [], byRegion: {},
      writtenIn: { total: added.length, rawEntries: addedRaw, matchedByEmail: addedByEmail,
        imported: addedImported, duplicateFlagged: addedDuplicateFlagged, noRegion: addedNoRegion },
    };
    const unknown = new Set();
    for (const [, e] of byId) for (const a of e.areas) if (!AREAS.has(a)) unknown.add(a);
    report.unknownAreas = [...unknown];

    const seenIds = new Set();
    function applyTo(v) {
      const e = byId.get(String(v.user_id));
      if (!e) return v;
      seenIds.add(String(v.user_id));
      const d = decisionFor(e);
      report.matched++;
      if (d.final_area) report.toStable++;
      else if (d.conflict_claims.length >= 2) report.toReconciliation++;
      else report.noArea++;
      if (d.leader) report.leaders++;

      // A volunteer who has ALREADY been through calling, whose fresh review now lands them in a
      // DIFFERENT area, is reopened into that new area — same shape as a caller's decline-referral,
      // but triggered by the review migration. Their stale call state is cleared so the receiving
      // area re-calls them, and a note records why.
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

    for (const region of REGIONS) {
      const newOnes = writeinsByRegion[region] || [];
      if (commit) {
        const out = await mergeRegion(container, region, (existing) => {
          const mapped = existing.map(applyTo);
          const have = new Set(mapped.map(v => String(v.user_id)));
          for (const w of newOnes) if (!have.has(String(w.user_id))) mapped.push(w);   // idempotent upsert
          return mapped;
        });
        report.byRegion[region] = out.length;
      } else {
        (recordsByRegion[region] || []).forEach(applyTo);
        const have = new Set((recordsByRegion[region] || []).map(v => String(v.user_id)));
        const fresh = newOnes.filter(w => !have.has(String(w.user_id))).length;
        report.byRegion[region] = (recordsByRegion[region] || []).length + fresh;
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
