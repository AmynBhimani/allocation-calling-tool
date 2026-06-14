const { getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");

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
const hasContact = v => v.bi_update_needed && v.contact_changes && Object.keys(v.contact_changes).length > 0;
const needsRow = v => hasContact(v) || !!v.bi_correction_needed;

function row(v) {
  return {
    id: v.user_id, first: v.first, last: v.last, region: v.region, jk: v.ceremony_jk,
    committee: v.final_area || "—", username: v.username || "",
    changes: hasContact(v) ? v.contact_changes : null,   // { field: {from,to} }
    reopen: !!v.bi_correction_needed                      // was entered in BI, then reopened
  };
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const allowed = roles.includes("superadmin") || roles.includes("admin");
    if (!email || !allowed) { context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const out = [];
      for (const region of REGIONS) {
        const { records } = await readRegion(container, region);
        for (const v of records) if (needsRow(v)) out.push(row(v));
      }
      out.sort((a, b) => a.region.localeCompare(b.region) || (a.committee || "").localeCompare(b.committee || "") || a.last.localeCompare(b.last));
      const contactCount = out.filter(r => r.changes).length;
      const reopenCount = out.filter(r => r.reopen).length;
      context.res = { body: { rows: out, count: out.length, contactCount, reopenCount } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items : [];   // [{user_id, region}]
      if (!items.length) { context.res = { status: 400, body: { error: "No volunteers given." } }; return; }
      let done = 0;
      for (const it of items) {
        if (!REGIONS.includes(it.region)) continue;
        const result = await mutateVolunteer(container, it.region, it.user_id, (v) => {
          v.activity_log = v.activity_log || [];
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "bi_updated" });
          v.contact_changes = {};
          v.bi_update_needed = false;
          v.bi_correction_needed = false;
        });
        if (result.ok) done++;
      }
      context.res = { body: { ok: true, updated: done } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
