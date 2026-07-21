// Bulk disposition applier. Takes a REVIEWED list of {user_id, disposition} (produced from the Better
// Impact cross-reference — the rules live in that analysis, not here) and applies block / inactivate /
// needs_bi. This is the one writer for that decision.
//   POST {commit:false} -> DRY RUN: resolve every id, report per-disposition counts, how many are already
//                          done, and how many are currently accepted / on a lineup / hold a duty, plus the
//                          not-found and invalid rows. Writes nothing — this is the gate.
//   POST {commit:true}  -> COMMIT: apply each disposition (one safe merge-write per region), skipping any
//                          already applied. Idempotent, so re-running is safe.
// Super Admin / Admin only; Admin is region-walled — ids outside your regions are reported, never touched.
const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { applyDisposition, alreadyApplied, onLineup, DISPOSITIONS } = require("../shared/disposition");
const { isAcceptedVolunteer } = require("../shared/rollup");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const SAMPLE_PER_KIND = 20;

const REASONS = {
  block: "Ceremony JK not in BC/Prairies/Edmonton",
  inactivate: "No visit registration \u2014 has not expressed interest to volunteer",
  needs_bi: "No Better Impact account",
};

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const clean = (s) => String(s == null ? "" : s).trim();
const nameOf = (v) => ((v.first || "") + " " + (v.last || "")).trim() || "(no name)";
const holdsDuty = (v) => (Array.isArray(v.event_assignments) ? v.event_assignments : [])
  .some(r => r && r.basis === "session" && clean(r.duty));
const KINDS = ["block", "inactivate", "needs_bi"];
const zero = () => ({ block: 0, inactivate: 0, needs_bi: 0 });

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
    if (!email || !(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }
    if (String(req.method || "").toUpperCase() !== "POST") { context.res = { status: 405, body: { error: "POST a list of items." } }; return; }

    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) { context.res = { status: 400, body: { error: "No items supplied." } }; return; }
    const commit = body.commit === true;

    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = (region) => isSuper || (allowed && allowed.includes(region));
    const scopeRegions = REGIONS.filter(inScope);
    const container = await getContainer(DATA_CONTAINER);

    // Normalize + dedupe (first occurrence wins); drop rows with a bad disposition or no id.
    const items = []; const seen = new Set();
    let invalid = 0; const invalidSample = [];
    for (const it of rawItems) {
      const uid = clean(it && (it.user_id != null ? it.user_id : it.uid));
      const disp = clean(it && it.disposition);
      if (!uid || !DISPOSITIONS.has(disp)) { invalid++; if (invalidSample.length < SAMPLE_PER_KIND) invalidSample.push({ user_id: uid, disposition: disp }); continue; }
      if (seen.has(uid)) continue;
      seen.add(uid); items.push({ user_id: uid, disposition: disp });
    }

    // Resolve each id to its region (and record), one read per region.
    const loc = new Map();   // uid -> { region, v }
    for (const region of scopeRegions) {
      const { records } = await readRegion(container, region);
      for (const v of records) loc.set(String(v.user_id), { region, v });
    }

    const byRegion = {};   // region -> [{user_id, disposition}]
    let notFound = 0; const notFoundSample = [];
    for (const it of items) {
      const hit = loc.get(it.user_id);
      if (!hit) { notFound++; if (notFoundSample.length < SAMPLE_PER_KIND) notFoundSample.push(it.user_id); continue; }
      (byRegion[hit.region] = byRegion[hit.region] || []).push(it);
    }

    // ---- DRY RUN ----
    if (!commit) {
      const kinds = {}; for (const k of KINDS) kinds[k] = { count: 0, already: 0, accepted: 0, onLineup: 0, holdsDuty: 0, sample: [] };
      for (const region of Object.keys(byRegion)) {
        for (const it of byRegion[region]) {
          const v = loc.get(it.user_id).v; const k = kinds[it.disposition];
          k.count++;
          if (alreadyApplied(v, it.disposition)) k.already++;
          const acc = isAcceptedVolunteer(v), lin = onLineup(v);
          if (acc) k.accepted++;
          if (lin) k.onLineup++;
          if (holdsDuty(v)) k.holdsDuty++;
          if (k.sample.length < SAMPLE_PER_KIND) k.sample.push({ user_id: it.user_id, region, name: nameOf(v), area: v.final_area || "", accepted: acc, onLineup: lin });
        }
      }
      context.res = { body: { mode: "dry-run", requested: rawItems.length, resolvable: items.length - notFound,
        notFound, notFoundSample, invalid, invalidSample, kinds } };
      return;
    }

    // ---- COMMIT ----
    // Retry-safe: mergeRegion re-runs the closure on a write conflict, so the per-region counters are
    // declared outside but reset at the top of each run and overwritten — the last (successful) run wins.
    const nowIso = new Date().toISOString();
    const applied = zero(), already = zero();
    for (const region of Object.keys(byRegion)) {
      const want = new Map(byRegion[region].map(it => [it.user_id, it.disposition]));
      const appliedThis = zero(), alreadyThis = zero();
      await mergeRegion(container, region, (records) => {
        for (const k of KINDS) { appliedThis[k] = 0; alreadyThis[k] = 0; }
        for (const v of records) {
          const disp = want.get(String(v.user_id));
          if (!disp) continue;
          if (alreadyApplied(v, disp)) { alreadyThis[disp]++; continue; }
          applyDisposition(v, disp, REASONS[disp], email, nowIso);
          appliedThis[disp]++;
        }
        return records;
      });
      for (const k of KINDS) { applied[k] += appliedThis[k]; already[k] += alreadyThis[k]; }
    }
    context.res = { body: { ok: true, mode: "commit", applied, already, notFound, invalid } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
