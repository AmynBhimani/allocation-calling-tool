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
        if (!e) { e = { first: a.first || "", last: a.last || "", email: a.email || "", phone: a.phone || "", ceremonyJk: a.ceremonyJk || "", areas: new Set() }; addedMap.set(k, e); }
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
    const recordsByRegion = {};
    for (const region of REGIONS) {
      const { records } = await readRegion(container, region);
      recordsByRegion[region] = records;
      for (const v of records) {
        const em = normEmail(v.email);
        if (em && !emailIndex.has(em)) emailIndex.set(em, { region, user_id: v.user_id, name: ((v.first || "") + " " + (v.last || "")).trim() });
        const nm = normName(v.first, v.last);
        if (nm) { if (!nameIndex.has(nm)) nameIndex.set(nm, []); nameIndex.get(nm).push({ region, user_id: v.user_id, email: v.email || "" }); }
      }
    }

    // Resolve the write-ins three ways.
    const nameSuggestions = [];
    let addedByEmail = 0, addedUnmatched = 0;
    for (const a of added) {
      const em = normEmail(a.email);
      if (em && emailIndex.has(em)) {
        // Reliable match — fold their area(s) into the matched person's aggregate so they're
        // applied exactly like a reviewed person (single -> Stable, two+ -> In reconciliation).
        const w = emailIndex.get(em);
        let e = byId.get(String(w.user_id));
        if (!e) { e = { areas: new Set(), leader: false }; byId.set(String(w.user_id), e); }
        for (const ar of a.areas) e.areas.add(ar);
        addedByEmail++;
        continue;
      }
      const nm = normName(a.first, a.last);
      const cands = nm ? (nameIndex.get(nm) || []) : [];
      if (cands.length >= 1) {
        nameSuggestions.push({
          name: (a.first + " " + a.last).trim(), email: a.email || "", jk: a.ceremonyJk || "",
          areas: [...a.areas], ambiguous: cands.length > 1,
          candidates: cands.slice(0, 5).map(c => ({ user_id: c.user_id, region: c.region, email: c.email || "" })),
        });
        continue;
      }
      addedUnmatched++;
    }

    const report = {
      mode: commit ? "commit" : "preview",
      reviewerBlobs: reviewerCount, reviewActiveIds: byId.size,
      matched: 0, toStable: 0, toReconciliation: 0, leaders: 0, noArea: 0,
      reviewIdsNotInWorkspace: 0, unknownAreas: [], byRegion: {},
      writtenIn: { total: added.length, rawEntries: addedRaw, matchedByEmail: addedByEmail, nameSuggestions: nameSuggestions.length, unmatched: addedUnmatched },
      nameSuggestions,
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
      if (!commit) return v;
      const nv = { ...v };
      nv.final_area = d.final_area;
      nv.conflict_claims = d.conflict_claims;
      nv.leader_flag = d.leader || !!nv.leader_flag;
      nv.never_reviewed = false;
      nv.callable_status = computeCallableStatus(nv);
      if (nv.final_area) nv.event_assignments = seedEventAssignments(nv, didars);
      nv.activity_log = nv.activity_log || [];
      nv.activity_log.push({ ts: new Date().toISOString(), actor: email || "transfer",
        action: "transfer_reconcile", to: nv.final_area || null, claims: d.conflict_claims.length });
      return nv;
    }

    for (const region of REGIONS) {
      if (commit) {
        const out = await mergeRegion(container, region, (existing) => existing.map(applyTo));
        report.byRegion[region] = out.length;
      } else {
        (recordsByRegion[region] || []).forEach(applyTo);
        report.byRegion[region] = (recordsByRegion[region] || []).length;
      }
    }
    report.reviewIdsNotInWorkspace = [...byId.keys()].filter(id => !seenIds.has(id)).length;
    report.note = commit
      ? "Applied review decisions and email-matched write-ins. Single-area people are Stable with a Didar row; contested are In reconciliation; leaders flagged. Name-match suggestions and no-BI write-ins were NOT applied."
      : "Preview only — nothing written. Email-matched write-ins are folded into the counts; name suggestions and no-BI write-ins are listed but never auto-applied.";
    context.res = { body: report };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
