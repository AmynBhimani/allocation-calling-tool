// Accepted Volunteers: everyone who has accepted a duty (call outcome Accepted, self-confirm, or iVol-ready),
// scoped to what the viewer is allowed to see. Super Admin & Leadership see all; Admin & Duty Team see
// their event regions; Quarterbacks see only their area×region. Leadership (do-not-allocate) is excluded.
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { isAcceptedVolunteer, dutiesOf } = require("../shared/rollup");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const clean = (s) => String(s == null ? "" : s).trim();

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
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
const iffOf = (v) => !!v.interfaith || v.list === "IFF";
const diverseOf = (v) => /diverse/i.test(String(v.list || ""));
// Quarterback / caller area×region scopes from the role store.
const scopesFor = (store, email, role) => store
  .filter(a => clean(a.email).toLowerCase() === email && clean(a.role) === role && clean(a.area))
  .map(a => ({ area: clean(a.area), region: clean(a.region) }));
const inScope = (scopes, area, region) => scopes.some(s => s.area === area && s.region === region);
function acceptedAt(v) {
  let when = null;
  for (const e of (v.activity_log || [])) if (e.action === "outcome" && e.outcome === "Accepted") when = e.ts;
  return when;
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const ALLOWED = ["superadmin", "admin", "dutyteam", "quarterback", "leadership"];
    if (!email || !roles.some(r => ALLOWED.includes(r))) {
      context.res = { status: 403, body: { error: "Not authorized for this view." } }; return;
    }

    const seeAll = roles.includes("superadmin") || roles.includes("leadership");
    // Contact visibility deliberately mirrors api/volunteer's gate: the Duty Team can see who accepted,
    // but not their contact details. Emails are only put in this payload for roles that can already
    // see them one-by-one in the detail panel — the export must not widen who can read PII.
    const canSeeContact = roles.includes("superadmin") || roles.includes("admin")
      || roles.includes("leadership") || roles.includes("quarterback");
    let regionScope = null;   // admin/dutyteam: a Set of regions (all areas within)
    let qbScopes = [];        // quarterback: [{area, region}]
    if (!seeAll) {
      const store = await readRolesStore();
      if (roles.includes("admin") || roles.includes("dutyteam")) regionScope = new Set(allowedRegionsFor(store, email));
      if (roles.includes("quarterback")) qbScopes = scopesFor(store, email, "quarterback");
    }
    const inUserScope = (v) => {
      if (seeAll) return true;
      if (regionScope && regionScope.has(v.region)) return true;
      if (qbScopes.length && inScope(qbScopes, v.final_area, v.region)) return true;
      return false;
    };

    // Only read regions the viewer can touch.
    let regions;
    if (seeAll) regions = REGIONS;
    else { const rs = new Set(); if (regionScope) regionScope.forEach(r => rs.add(r)); qbScopes.forEach(s => rs.add(s.region)); regions = REGIONS.filter(r => rs.has(r)); }

    const container = await getContainer(DATA_CONTAINER);
    const vols = [];
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        if (!isAcceptedVolunteer(v)) continue;   // shared definition (excludes Leadership)
        if (!inUserScope(v)) continue;
        vols.push({
          id: v.user_id, name: ((v.first || "") + " " + (v.last || "")).trim() || "(no name)",
          region, jk: v.ceremony_jk || "", area: v.final_area || "", age: ageOf(v), iff: iffOf(v), diverse: diverseOf(v),
          entered: !!v.ivol_entered, acceptedAt: acceptedAt(v), duties: dutiesOf(v),
          assignedDuty: String(v.assigned_duty || "").trim(),   // the duty they were GIVEN (vs duties = interest)
          email: canSeeContact ? String(v.email || "").trim() : "",
        });
      }
    }
    vols.sort((a, b) => (a.region + a.name).localeCompare(b.region + b.name));
    context.res = { body: { volunteers: vols, count: vols.length, canEmail: canSeeContact } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
