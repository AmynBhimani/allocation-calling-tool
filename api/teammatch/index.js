// Matches rows from the "Existing Team Members" file (the same one used in the review tool) to people
// already in the allocation workspace, and reports whether each is eligible to be marked Accepted without
// a call. The file carries NO Better Impact id, so we match by identity the way the review tool does:
// email first, then phone, using the name to disambiguate when a contact is shared (families often share
// one). This is a READ-ONLY dry run — it resolves and evaluates, it does not accept. The migration screen
// then sends the chosen matched user_ids to /api/bulkaccept to commit. Admin or Super Admin (region-walled).
const { getContainer, readRegion, REGIONS, readRolesStore, allowedRegionsFor } = require("../shared/store");
const { acceptGuard } = require("../shared/accept");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const normEmail = e => String(e == null ? "" : e).trim().toLowerCase();
const normPhone = p => { const d = String(p == null ? "" : p).replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const normName = (f, l) => (String(f || "") + " " + String(l || "")).replace(/\s+/g, " ").trim().toLowerCase();
const regionOfJk = jk => { jk = String(jk == null ? "" : jk); return jk.includes(" - ") ? jk.split(" - ")[0].trim() : jk.trim(); };
const nm = v => ((v.first || "") + " " + (v.last || "")).trim() || ("#" + v.user_id);

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
    if (!email || !(isSuper || roles.includes("admin"))) { context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return; }

    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!rows.length) { context.res = { status: 400, body: { error: "No rows found in the file." } }; return; }
    if (rows.length > 5000) { context.res = { status: 400, body: { error: "That file is unusually large (>5000 rows). Please check it." } }; return; }

    const allowed = isSuper ? null : allowedRegionsFor(await readRolesStore(), email);
    const inScope = region => isSuper || (allowed && allowed.includes(region));
    const scopeRegions = REGIONS.filter(inScope);
    const container = await getContainer(DATA_CONTAINER);

    // Index the workspace: email, phone (any of cell/home/work), and name+region.
    const byEmail = new Map(), byPhone = new Map(), byNameRegion = new Map();
    const push = (map, key, v) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(v); };
    for (const region of scopeRegions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        push(byEmail, normEmail(v.email), v);
        for (const ph of [v.cell_phone, v.home_phone, v.work_phone]) push(byPhone, normPhone(ph), v);
        push(byNameRegion, normName(v.first, v.last) + "|" + (v.region || ""), v);
      }
    }

    const matched = [], ambiguous = [], notFound = [];
    const seenUser = new Set();

    for (const row of rows) {
      const rEmail = normEmail(row.email), rPhone = normPhone(row.phone), rName = normName(row.first, row.last);
      const rRegion = regionOfJk(row.jk);
      const label = { rowName: (String(row.first || "") + " " + String(row.last || "")).trim(), rowEmail: row.email || "", rowPhone: row.phone || "", rowJk: row.jk || "" };

      // Resolve candidates by the most reliable signal available.
      let cands = null, matchedBy = null;
      if (rEmail && byEmail.has(rEmail)) { cands = byEmail.get(rEmail); matchedBy = "email"; }
      else if (rPhone && byPhone.has(rPhone)) { cands = byPhone.get(rPhone); matchedBy = "phone"; }
      else if (rName && byNameRegion.has(rName + "|" + rRegion)) { cands = byNameRegion.get(rName + "|" + rRegion); matchedBy = "name"; }
      if (!cands || !cands.length) { notFound.push(label); continue; }

      // When a contact matched more than one person, disambiguate by name (the shared-contact case).
      let pick = cands.length > 1 ? cands.filter(v => normName(v.first, v.last) === rName) : cands;
      const uniq = [...new Map(pick.map(v => [String(v.user_id), v])).values()];
      if (uniq.length !== 1) {
        ambiguous.push({ ...label, matchedBy, candidates: (uniq.length ? uniq : cands).slice(0, 6).map(v => ({ user_id: v.user_id, name: nm(v), region: v.region, final_area: v.final_area || null })) });
        continue;
      }

      const v = uniq[0];
      if (seenUser.has(String(v.user_id))) continue;   // another row already matched this person
      seenUser.add(String(v.user_id));
      const g = acceptGuard(v);
      matched.push({ user_id: v.user_id, region: v.region, name: nm(v), rowName: label.rowName,
        final_area: v.final_area || null, matchedBy, eligible: !g, skipReason: g });
    }

    const eligible = matched.filter(m => m.eligible).length;
    context.res = { body: {
      counts: { rows: rows.length, matched: matched.length, eligible, skipped: matched.length - eligible, ambiguous: ambiguous.length, notFound: notFound.length },
      matched, ambiguous, notFound,
    } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
