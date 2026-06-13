const { getContainer, readRegion, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

// Super-Admin-only full export of the volunteer data, returned as a downloadable JSON file.
// This is a point-in-time, off-platform backup the admin keeps on their own drive.
module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const container = await getContainer(DATA_CONTAINER);
    const backup = { generated_at: new Date().toISOString(), source: DATA_CONTAINER, regions: {} };
    let total = 0;
    for (const region of REGIONS) {
      const { records } = await readRegion(container, region);
      backup.regions[region] = records;
      total += records.length;
    }
    backup.total = total;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="volunteer-backup-${stamp}.json"`,
        "cache-control": "no-store"
      },
      body: JSON.stringify(backup, null, 2)
    };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
