const { getContainer, overwriteRegion, REGIONS } = require("../shared/store");
const SEED = require("./data.json");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const container = await getContainer(DATA_CONTAINER);
    const byRegion = { BC: [], Prairies: [], Edmonton: [] };
    for (const v of SEED) {
      const r = REGIONS.includes(v.region) ? v.region : "BC";
      byRegion[r].push(v);
    }
    const counts = {};
    for (const r of REGIONS) {
      await overwriteRegion(container, r, byRegion[r]);
      counts[r] = byRegion[r].length;
    }
    context.res = { body: { ok: true, seeded: counts, total: SEED.length } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
