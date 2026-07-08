// Single-volunteer detail for the All Volunteers / Accepted side panels: contact numbers, email,
// preferred areas, any duties captured during calling, and the call-outcome history. Read-only.
// Super Admin / Admin / Leadership, region-walled to the viewer's events like the rest of the tool.
//   /api/volunteer?id=<user_id>&region=<Region>
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

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

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    if (!email || !(roles.includes("superadmin") || roles.includes("admin") || roles.includes("leadership"))) {
      context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return;
    }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const id = req.query && req.query.id;
    const region = req.query && req.query.region;
    if (id == null || id === "" || !region || !REGIONS.includes(region)) {
      context.res = { status: 400, body: { error: "id and a valid region are required." } }; return;
    }
    const isSuper = roles.includes("superadmin");
    const allowed = (isSuper || roles.includes("leadership")) ? null : allowedRegionsFor(await readRolesStore(), email);
    if (allowed && !allowed.includes(region)) {
      context.res = { status: 403, body: { error: "That region is outside your assigned events." } }; return;
    }

    const container = await getContainer(DATA_CONTAINER);
    const { records } = await readRegion(container, region);
    const v = records.find(r => String(r.user_id) === String(id));
    if (!v) { context.res = { status: 404, body: { error: "Volunteer not found in that region." } }; return; }

    // Duties captured across events (deduped) — the same candidate duties the Callers page surfaces.
    const duties = [...new Set((Array.isArray(v.event_assignments) ? v.event_assignments : [])
      .flatMap(a => Array.isArray(a.candidate_duties) ? a.candidate_duties : [])
      .map(d => String(d).trim()).filter(Boolean))];

    context.res = {
      body: {
        id: v.user_id,
        name: ((v.first || "") + " " + (v.last || "")).trim() || "(no name)",
        region, jk: v.ceremony_jk || "", area: v.final_area || "", age: ageOf(v),
        cell: v.cell_phone || "", home: v.home_phone || "", work: v.work_phone || "", email: v.email || "",
        duties,
        prefAreas: Array.isArray(v.pref_areas) ? v.pref_areas : [],
        happyAnywhere: !!v.happy_anywhere,
        log: (v.activity_log || []).filter(e => e.action === "outcome"),
      }
    };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
