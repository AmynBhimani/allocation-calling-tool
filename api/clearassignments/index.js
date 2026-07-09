// Clear PENDING call assignments back to the unassigned pool, so a quarterback can re-allocate cleanly
// after a bad bulk assign/restore. Two targeting modes:
//   /api/clearassignments?caller=a@x.ca,b@x.ca&dry=1     -> everything currently pointed at these callers
//   /api/clearassignments?area=<area>&region=<region>&dry=1 -> every assigned volunteer in that area+region
//
// SAFETY, in order:
//   * Dry run is the DEFAULT. Nothing is written unless you pass &commit=1.
//   * RESOLVED volunteers (call_outcome Accepted / Withdrew / Duplicate) are NEVER cleared. Their
//     assigned_caller is what Caller Activity counts and what attributes completed work, so wiping it
//     would silently zero out accepted totals. They are reported under keptResolved.
//   * Quarterbacks are walled to their own (area, region) scopes; anything outside is skipped and
//     reported as outOfScope. Super Admin is global.
//   * assigned_duty is left alone — reassigning a volunteer overwrites it anyway.
//   * Each cleared record gets an "unassign" log entry, so this reads as a deliberate removal later
//     (a future restorecaller run will correctly refuse to undo it without an explicit incident window).
const { getContainer, readRegion, mutateVolunteer, REGIONS, readRolesStore } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const RESOLVED_OUTCOMES = ["Accepted", "Withdrew", "Duplicate"];
const isResolved = (v) => RESOLVED_OUTCOMES.includes(v.call_outcome);

const clean = (s) => String(s == null ? "" : s).trim();
const nm = (v) => ((v.first || "") + " " + (v.last || "")).trim() || "(no name)";

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
const scopesFor = (store, email, role) => store
  .filter(a => clean(a.email).toLowerCase() === email && clean(a.role) === role)
  .map(a => ({ area: clean(a.area), region: clean(a.region) }));
const inScope = (scopes, area, region) => scopes.some(s => s.area === area && s.region === region);

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
    const isQB = roles.includes("quarterback");
    if (!email || (!isSuper && !isQB)) { context.res = { status: 403, body: { error: "Quarterback or Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const q = req.query || {};
    const commit = q.commit === "1" || q.commit === "true";
    const targetCallers = new Set(clean(q.caller).toLowerCase().split(",").map(s => s.trim()).filter(Boolean));
    const area = clean(q.area);
    const regionParam = clean(q.region);

    if (!targetCallers.size && !area) {
      context.res = { status: 400, body: { error: "Pass ?caller=<email>[,<email>] or ?area=<area>&region=<region>. Add &commit=1 to write; default is a dry run." } }; return;
    }
    if (area && !REGIONS.includes(regionParam)) {
      context.res = { status: 400, body: { error: "Area mode needs a valid &region=." } }; return;
    }
    if (regionParam && !REGIONS.includes(regionParam)) {
      context.res = { status: 400, body: { error: "Unknown region." } }; return;
    }

    const store = await readRolesStore();
    const qbScopes = isSuper ? null : scopesFor(store, email, "quarterback");
    if (qbScopes && !qbScopes.length) { context.res = { status: 403, body: { error: "You have no quarterback scopes." } }; return; }

    const regions = regionParam ? [regionParam] : REGIONS.slice();
    const container = await getContainer(DATA_CONTAINER);

    const toClear = [];
    let keptResolved = 0, outOfScope = 0;
    const perCaller = {};
    const bump = (c, k) => { perCaller[c] = perCaller[c] || { cleared: 0, keptResolved: 0, outOfScope: 0 }; perCaller[c][k]++; };

    for (const region of regions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        const ac = clean(v.assigned_caller).toLowerCase();
        if (!ac) continue;                                                  // already unassigned
        const hit = targetCallers.size ? targetCallers.has(ac) : (clean(v.final_area) === area);
        if (!hit) continue;
        if (qbScopes && !inScope(qbScopes, clean(v.final_area), clean(v.region))) { outOfScope++; bump(ac, "outOfScope"); continue; }
        if (isResolved(v)) { keptResolved++; bump(ac, "keptResolved"); continue; }   // completed work — never touch
        toClear.push({ user_id: v.user_id, region, name: nm(v), caller: ac, outcome: v.call_outcome || null });
      }
    }

    let cleared = 0, failed = 0;
    if (commit) {
      for (const t of toClear) {
        const res = await mutateVolunteer(container, t.region, t.user_id, (v) => {
          if (isResolved(v)) return { skip: "resolved" };                   // re-check at write time
          if (!clean(v.assigned_caller)) return { skip: "already" };
          v.assigned_caller = null;
          v.call_done = false; v.call_outcome = null; v.ivol_ready = false; // back to a clean, callable state
          v.activity_log = v.activity_log || [];
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "unassign", note: "Bulk clear for re-allocation." });
        });
        if (res.ok && !(res.extra && res.extra.skip)) { cleared++; bump(t.caller, "cleared"); } else failed++;
      }
    } else {
      for (const t of toClear) bump(t.caller, "cleared");   // "would clear"
    }

    context.res = {
      body: {
        dryRun: !commit,
        mode: targetCallers.size ? "caller" : "area",
        target: targetCallers.size ? [...targetCallers] : { area, region: regionParam },
        regionsScanned: regions,
        wouldClear: commit ? undefined : toClear.length,
        cleared: commit ? cleared : undefined,
        failed: commit ? failed : undefined,
        keptResolved, outOfScope,
        perCaller,
        detail: toClear.slice(0, 500),
        note: commit
          ? "Pending assignments cleared. Resolved volunteers (Accepted/Withdrew/Duplicate) were left untouched."
          : "Preview only — nothing written. Re-run with &commit=1 to clear. Resolved volunteers are never cleared.",
      }
    };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
