// Release held-aside volunteers back into the allocation pool.
// A volunteer held aside (e.g. bulk-marked Medical/Registration) carries final_area + affinity and
// never_reviewed=false, which keeps them OUT of the pool. Releasing flips them back to allocatable
// (never_reviewed=true, area cleared) and stamps released_to_pool so a future transfer won't silently
// re-hold them. The NEXT allocation then places them by their Better Impact preferences.
//
// Two callers, one logic:
//   - Calltool users (quarterback / dutyteam / admin / superadmin) via their signed-in session.
//   - The review tool, on behalf of any reviewer, via the shared secret RELEASE_TRIGGER_KEY
//     (header x-release-key) — the review-tool user has no calltool login.
//
// Body: { user_id, region }  OR  { items: [{ user_id, region }, ...] }  (bulk).

const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { callerLocked } = require("../shared/status");
const { repool } = require("../shared/repool");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const ALLOWED_ROLES = ["superadmin", "admin", "dutyteam", "quarterback"];
const LEADERSHIP = "Leadership - Do Not Allocate";

// A "held aside" person = the transfer gave them an area from review (never_reviewed=false, area set),
// they haven't been released yet, aren't Leadership, and no caller is working them. These are the
// people (e.g. bulk-marked Medical/Registration) who can be sent back to the pool.
function isHeldAside(v) {
  return !!v.final_area && v.never_reviewed === false && !v.released_to_pool
    && v.callable_status !== LEADERSHIP && !callerLocked(v);
}

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
function emailOf(p) {
  if (!p) return null;
  let e = p.userDetails || null;
  if (!e && Array.isArray(p.claims)) {
    const c = p.claims.find(c => /(emailaddress|email|preferred_username|upn)$/i.test(c.typ || c.type || ""));
    if (c) e = c.val || c.value;
  }
  return e ? String(e).toLowerCase() : null;
}


module.exports = async function (context, req) {
  try {
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    // --- auth: shared secret (review tool) OR a signed-in calltool role ---
    const key = process.env.RELEASE_TRIGGER_KEY;
    const presented = req.headers["x-release-key"] || (req.query && req.query.key) || "";
    const viaSecret = !!key && presented === key;

    // Safe diagnostic: /api/release?diag=1 (optionally &key=...) reports whether the calltool has a
    // key configured and how the presented value compares — lengths only, never the secret itself.
    if (req.query && req.query.diag === "1") {
      const norm = (s) => (s || "").trim();
      context.res = { body: {
        keyConfigured: !!key,
        configuredLen: key ? key.length : 0,
        presentedLen: presented.length,
        equal: !!key && presented === key,
        equalIfTrimmed: !!key && norm(presented) === norm(key),
        sawHeader: !!req.headers["x-release-key"],
        sawQueryKey: !!(req.query && req.query.key),
      } };
      return;
    }

    // Data diagnostics (require the secret, since they reveal volunteer status):
    //   ?diag=counts&key=...          -> how many people are held aside, by area, per region
    //   ?diag=who&name=Smith&key=...  -> inspect specific people: is each actually held aside, and why not
    if (req.query && (req.query.diag === "counts" || req.query.diag === "who")) {
      if (!viaSecret) { context.res = { status: 403, body: { error: "Add &key=<your key> to use this diagnostic." } }; return; }
      const container = await getContainer(DATA_CONTAINER);
      if (req.query.diag === "counts") {
        const out = {};
        for (const region of REGIONS) {
          const { records } = await readRegion(container, region);
          const byArea = {};
          for (const v of records) if (isHeldAside(v)) byArea[v.final_area] = (byArea[v.final_area] || 0) + 1;
          out[region] = byArea;
        }
        context.res = { body: { heldAsideByArea: out } };
        return;
      }
      const name = String((req.query && req.query.name) || "").toLowerCase().trim();
      const hits = [];
      for (const region of REGIONS) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          const nm = ((v.first || "") + " " + (v.last || "")).toLowerCase().trim();
          if (name && nm.includes(name)) hits.push({
            id: v.user_id, region, name: nm,
            final_area: v.final_area || null, never_reviewed: v.never_reviewed,
            released_to_pool: !!v.released_to_pool, callable_status: v.callable_status,
            callerLocked: callerLocked(v), isHeldAside: isHeldAside(v),
          });
        }
      }
      context.res = { body: { count: hits.length, people: hits.slice(0, 25) } };
      return;
    }

    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const viaRole = !!email && roles.some(r => ALLOWED_ROLES.includes(r));

    if (!viaSecret && !viaRole) { context.res = { status: 403, body: { error: "Not authorized to release volunteers." } }; return; }
    const actor = viaRole ? email : "review-tool";

    // Region wall applies to signed-in non-super users; the secret path (review tool) is unscoped.
    const isSuper = roles.includes("superadmin");
    const allowed = (viaRole && !isSuper) ? allowedRegionsFor(await readRolesStore(), email) : null;
    const scopeRegions = allowed ? REGIONS.filter(r => allowed.includes(r)) : REGIONS;
    const container = await getContainer(DATA_CONTAINER);

    // --- GET: list held-aside people (signed-in roles only) ---
    if (req.method === "GET") {
      if (!viaRole) { context.res = { status: 403, body: { error: "Sign in to view held-aside volunteers." } }; return; }
      const only = req.query && req.query.region;
      const regions = (only && scopeRegions.includes(only)) ? [only] : scopeRegions;
      const out = [];
      for (const r of regions) {
        const { records } = await readRegion(container, r);
        for (const v of records) if (isHeldAside(v)) {
          out.push({ id: v.user_id, first: v.first, last: v.last, region: v.region, jk: v.ceremony_jk, area: v.final_area });
        }
      }
      out.sort((a, b) => (a.area || "").localeCompare(b.area || "") || String(a.last).localeCompare(String(b.last)));
      context.res = { body: { volunteers: out, count: out.length } };
      return;
    }

    // --- collect the targets (POST) ---
    const body = req.body || {};
    let items = Array.isArray(body.items) ? body.items : [];
    if (!items.length && body.user_id != null) items = [{ user_id: body.user_id, region: body.region }];
    if (!items.length) { context.res = { status: 400, body: { error: "Provide user_id (+ region), or items[]." } }; return; }

    // Requested ids, each optionally carrying a region. The review tool sends id only, so any item
    // without a valid region is resolved by scanning the in-scope shards for that id.
    const requested = new Set();
    const byRegion = new Map();               // region -> Set(id) with a known region
    const needResolve = new Set();            // ids with no (valid, in-scope) region given
    for (const it of items) {
      if (!it || it.user_id == null) continue;
      const id = String(it.user_id); requested.add(id);
      const region = it.region;
      if (REGIONS.includes(region) && (!allowed || allowed.includes(region))) {
        if (!byRegion.has(region)) byRegion.set(region, new Set());
        byRegion.get(region).add(id);
      } else { needResolve.add(id); }
    }
    if (needResolve.size) {
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          const id = String(v.user_id);
          if (needResolve.has(id)) { if (!byRegion.has(region)) byRegion.set(region, new Set()); byRegion.get(region).add(id); }
        }
      }
    }
    if (!byRegion.size) { context.res = { status: 400, body: { error: "No valid, in-scope targets." } }; return; }

    let released = 0, skippedLocked = 0, skippedNotHeld = 0;
    const resolved = new Set();

    for (const [region, ids] of byRegion) {
      await mergeRegion(container, region, (records) => records.map(v => {
        const id = String(v.user_id);
        if (!ids.has(id)) return v;
        resolved.add(id);
        if (callerLocked(v)) { skippedLocked++; return v; }        // never yank an in-progress call
        if (!isHeldAside(v)) { skippedNotHeld++; return v; }        // only release review-held people
        if (repool(v, actor)) released++;
        return v;
      }));
    }
    let notFound = 0;
    for (const id of requested) if (!resolved.has(id)) notFound++;

    context.res = { body: { ok: true, released, skippedLocked, skippedNotHeld, notFound } };
    return;
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
