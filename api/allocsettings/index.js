// Persists the last-used allocation settings (target %/age per area, plus the run toggles) so the
// Allocation tab reopens with what was used last time. Super Admin only, same as the allocation itself.
const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
const BLOB = "allocation-settings.json";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
function streamToString(s) {
  return new Promise((res, rej) => {
    const ch = []; s.on("data", d => ch.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(ch).toString("utf8"))); s.on("error", rej);
  });
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
    await c.createIfNotExists();
    const b = c.getBlockBlobClient(BLOB);

    if (req.method === "GET") {
      if (!(await b.exists())) { context.res = { body: { settings: null } }; return; }
      try { context.res = { body: { settings: JSON.parse(await streamToString((await b.download()).readableStreamBody)) } }; }
      catch { context.res = { body: { settings: null } }; }
      return;
    }

    if (req.method === "POST") {
      const settings = (req.body && req.body.settings) || null;
      if (!settings || typeof settings !== "object") { context.res = { status: 400, body: { error: "No settings supplied." } }; return; }
      const rec = { ...settings, savedAt: new Date().toISOString(), savedBy: (principal && principal.userDetails) || "" };
      const body = JSON.stringify(rec, null, 2);
      await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" } });
      context.res = { body: { ok: true, savedAt: rec.savedAt } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
