const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
// Super Admins come from an env var so the tool is never lockout-able from the role store.
const SUPER_ADMINS = (process.env.SUPER_ADMIN_EMAILS || "")
  .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);

function streamToString(s) {
  return new Promise((res, rej) => {
    const ch = []; s.on("data", d => ch.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(ch).toString("utf8"))); s.on("error", rej);
  });
}
// Role store: app-config/roles.json => [{ email, role, region?, area? }, ...]
async function readRoleStore() {
  if (!CONN) return [];
  try {
    const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
    const b = c.getBlockBlobClient("roles.json");
    if (!(await b.exists())) return [];
    const obj = JSON.parse(await streamToString((await b.download()).readableStreamBody));
    return Array.isArray(obj) ? obj : (obj.assignments || []);
  } catch { return []; }
}

const VALID = ["superadmin", "admin", "dutyteam", "quarterback", "caller", "ivoladmin", "leadership"];

module.exports = async function (context, req) {
  const p = (req.body && req.body) || {};
  let email = p.userDetails || "";
  if (!email && Array.isArray(p.claims)) {
    const c = p.claims.find(c => /(email|preferred_username|upn)$/i.test(c.typ || ""));
    if (c) email = c.val || "";
  }
  email = String(email).toLowerCase().trim();

  const roles = new Set();
  if (SUPER_ADMINS.includes(email)) roles.add("superadmin");

  const store = await readRoleStore();
  for (const a of store) {
    if (!a || String(a.email || "").toLowerCase().trim() !== email) continue;
    const r = String(a.role || "").toLowerCase().trim();
    if (VALID.includes(r)) roles.add(r);
  }

  context.res = { body: { roles: [...roles] } };
};
