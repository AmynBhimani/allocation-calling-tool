// Stores offline-filled Jamatkhana corrections for stranded write-ins, keyed by the same match_key the
// migration exports. On the next migration, a JK-less write-in with an override inherits that JK and
// places normally. Super Admin only.
const { BlobServiceClient } = require("@azure/storage-blob");
const { REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
const BLOB = "writein-jk-overrides.json";

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
// A JK is usable only if its "Region - …" prefix resolves to a real region.
function regionFromJk(jk) {
  const s = String(jk || "").trim();
  const pre = s.split(/\s*-\s*/)[0].trim();
  if (REGIONS.includes(pre)) return pre;
  if (REGIONS.includes(s)) return s;
  return null;
}
async function readOverrides(c) {
  const b = c.getBlockBlobClient(BLOB);
  if (!(await b.exists())) return {};
  try { const o = JSON.parse(await streamToString((await b.download()).readableStreamBody)); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; }
  catch { return {}; }
}
async function writeOverrides(c, obj) {
  const b = c.getBlockBlobClient(BLOB);
  const body = JSON.stringify(obj, null, 2);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" } });
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
    await c.createIfNotExists();

    if (req.method === "GET") {
      const cur = await readOverrides(c);
      context.res = { body: { count: Object.keys(cur).length, overrides: cur } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const items = Array.isArray(body.overrides) ? body.overrides : [];
      if (!items.length && body.replace !== true) { context.res = { status: 400, body: { error: "No overrides supplied." } }; return; }
      const cur = body.replace === true ? {} : await readOverrides(c);   // replace:true wipes the table first
      let stored = 0, cleared = 0, invalid = 0;
      const invalidList = [];
      for (const it of items) {
        const key = String((it && (it.match_key != null ? it.match_key : it.key)) || "").trim();
        const jk = String((it && (it.ceremony_jk != null ? it.ceremony_jk : it.jk)) || "").trim();
        if (!key) continue;
        if (!jk) { if (cur[key] !== undefined) { delete cur[key]; cleared++; } continue; }   // blank JK clears an override
        if (!regionFromJk(jk)) { invalid++; if (invalidList.length < 100) invalidList.push({ match_key: key, ceremony_jk: jk }); continue; }
        cur[key] = jk; stored++;
      }
      await writeOverrides(c, cur);
      context.res = { body: { ok: true, stored, cleared, invalid, invalidList, total: Object.keys(cur).length } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
