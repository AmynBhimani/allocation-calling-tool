// Distinct ceremony Jamatkhanas pulled from the live volunteer data, grouped by region, each with a
// headcount and an accepted-headcount. The Events screen uses this to build a session's Jamatkhana
// checklist (instead of free-text), so a session's JK list is chosen from JKs that actually exist.
// Super/admin only — this is session setup.
const { getContainer, readRegion, REGIONS } = require("../shared/store");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
const lc = (s) => String(s == null ? "" : s).toLowerCase();
// "Accepted" = said yes on the call (or already confirmed / entered in iVol). This is the pool that
// Phase 2 will actually place into sessions, so the accepted count previews each session's real size.
const isAccepted = (v) => !!(v && (v.ivol_entered || v.confirmed_at || v.ivol_ready || lc(v.call_outcome) === "accepted"));

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    if (!(roles.includes("superadmin") || roles.includes("admin"))) {
      context.res = { status: 403, body: { error: "Not authorized." } }; return;
    }
    const container = await getContainer(DATA_CONTAINER);

    // jk -> { total, accepted }, per region. Read regions concurrently.
    const byRegion = {};
    for (const R of REGIONS) byRegion[R] = new Map();
    await Promise.all(REGIONS.map(async (R) => {
      let recs = [];
      try { recs = (await readRegion(container, R)).records || []; } catch { recs = []; }
      const m = byRegion[R];
      for (const v of recs) {
        const jk = String(v.ceremony_jk == null ? "" : v.ceremony_jk).trim();
        if (!jk) continue;
        let e = m.get(jk);
        if (!e) { e = { total: 0, accepted: 0 }; m.set(jk, e); }
        e.total++;
        if (isAccepted(v)) e.accepted++;
      }
    }));

    const regions = {};
    for (const R of REGIONS) {
      regions[R] = [...byRegion[R].entries()]
        .map(([jk, c]) => ({ jk, total: c.total, accepted: c.accepted }))
        .sort((a, b) => a.jk.localeCompare(b.jk));
    }
    context.res = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ regions }) };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
