const { BlobServiceClient } = require("@azure/storage-blob");
const SEED = require("./data.json");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const REGIONS = ["BC", "Prairies", "Edmonton"];

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

    const svc = BlobServiceClient.fromConnectionString(CONN);
    const c = svc.getContainerClient(DATA_CONTAINER);
    await c.createIfNotExists();

    // group seed by region
    const byRegion = { BC: [], Prairies: [], Edmonton: [] };
    for (const v of SEED) {
      const r = REGIONS.includes(v.region) ? v.region : "BC";
      byRegion[r].push(v);
    }
    const counts = {};
    for (const r of REGIONS) {
      const b = c.getBlockBlobClient(`volunteers-${r}.json`);
      const body = JSON.stringify(byRegion[r]);
      await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, overwrite: true });
      counts[r] = byRegion[r].length;
    }
    context.res = { body: { ok: true, seeded: counts, total: SEED.length } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
