// Inactive & blocked volunteers, and the Activate action.
//   GET  -> list everyone with assignability inactive or blocked (name, region, JK, area, reason, when).
//           Inactive people can be Activated; blocked is terminal and shown read-only.
//   POST { user_ids:[...] } -> ACTIVATE: return each INACTIVE person to the normal flow (assignability ->
//           active). They stay un-accepted, so they re-enter allocation/calling like anyone else. Blocked
//           ids are refused (terminal), and ids that aren't inactive are reported, not touched.
// Super Admin / Admin only; Admin is region-walled.
const { getContainer, readRegion, mergeRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { activate } = require("../shared/disposition");
const { assignabilityOf, isInactive, isBlocked, ASSIGN_INACTIVE, ASSIGN_BLOCKED } = require("../shared/rollup");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const clean = (s) => String(s == null ? "" : s).trim();
const nameOf = (v) => ((v.first || "") + " " + (v.last || "")).trim() || "(no name)";

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
    if (!email || !(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Super Admin or Admin only." } }; return; }
    if (!process.env.RESPONSES_STORAGE) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = (region) => isSuper || (allowed && allowed.includes(region));
    const scopeRegions = REGIONS.filter(inScope);
    const container = await getContainer(DATA_CONTAINER);

    // ---- GET: the list ----
    if (String(req.method || "").toUpperCase() !== "POST") {
      const people = [];
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          const a = assignabilityOf(v);
          if (a !== ASSIGN_INACTIVE && a !== ASSIGN_BLOCKED) continue;
          people.push({ user_id: v.user_id, name: nameOf(v), region, jk: v.ceremony_jk || "", area: v.final_area || "",
            assignability: a, reason: v.assignability_reason || "", at: v.assignability_at || "" });
        }
      }
      people.sort((x, y) => (x.assignability + x.region + x.name).localeCompare(y.assignability + y.region + y.name));
      const inactive = people.filter(p => p.assignability === ASSIGN_INACTIVE).length;
      const blocked = people.filter(p => p.assignability === ASSIGN_BLOCKED).length;
      context.res = { body: { people, counts: { inactive, blocked, total: people.length }, regions: scopeRegions } };
      return;
    }

    // ---- POST: activate ----
    const body = req.body || {};
    const wanted = Array.isArray(body.user_ids) ? body.user_ids.map(clean).filter(Boolean)
      : (body.user_id ? [clean(body.user_id)] : []);
    if (!wanted.length) { context.res = { status: 400, body: { error: "No user_ids supplied." } }; return; }
    const want = new Set(wanted);

    const nowIso = new Date().toISOString();
    let activated = 0, skippedBlocked = 0, notInactive = 0;
    for (const region of scopeRegions) {
      let a = 0, b = 0, n = 0;
      await mergeRegion(container, region, (records) => {
        a = b = n = 0;
        for (const v of records) {
          if (!want.has(String(v.user_id))) continue;
          if (isBlocked(v)) { b++; continue; }       // terminal — never reactivated here
          if (!isInactive(v)) { n++; continue; }     // already active / not applicable
          activate(v, email, nowIso); a++;
        }
        return records;
      });
      activated += a; skippedBlocked += b; notInactive += n;
    }
    context.res = { body: { ok: true, activated, skippedBlocked, notInactive } };
  } catch (err) {
    context.res = { status: 500, body: { error: String((err && err.message) || err) } };
  }
};
