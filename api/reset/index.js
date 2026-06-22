const { getContainer, readRegion, overwriteRegion, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

// Super-Admin-only deliberate reset of the volunteer workspace.
// Clears the region shards in tool-data to empty so a fresh transfer can't mix with test data.
// Config (roles, events, duties in app-config) is NOT touched. Requires an explicit typed token.
// GET returns current counts (a preview, changes nothing). POST with { confirm:"RESET" } clears.
module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = (principal && principal.userDetails) || "";
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const counts = {}; let total = 0;
      for (const r of REGIONS) { const { records } = await readRegion(container, r); counts[r] = records.length; total += records.length; }
      context.res = { body: { container: DATA_CONTAINER, counts, total,
        note: "Preview only — nothing cleared. POST { confirm: \"RESET\" } to clear these shards. Back up first via /api/backup." } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      if (body.confirm !== "RESET") {
        context.res = { status: 400, body: { error: "Confirmation required. Send { confirm: \"RESET\" } to proceed." } };
        return;
      }
      const before = {}; let cleared = 0;
      for (const r of REGIONS) {
        const { records } = await readRegion(container, r);
        before[r] = records.length; cleared += records.length;
        await overwriteRegion(container, r, []);   // wipe shard to empty
      }
      context.res = { body: { ok: true, container: DATA_CONTAINER, cleared, before, by: email,
        note: "Volunteer shards cleared. Events, roles and the duty catalog were left intact. Ready for a fresh transfer." } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
