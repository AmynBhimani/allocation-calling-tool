const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";
// AREAS + the duplicate rule are shared with the roster import so both apply the same definition.
const { AREAS, dupOf, norm } = require("../shared/duties");

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
function streamToString(s) {
  return new Promise((res, rej) => {
    const ch = []; s.on("data", d => ch.push(Buffer.from(d)));
    s.on("end", () => res(Buffer.concat(ch).toString("utf8"))); s.on("error", rej);
  });
}
const clean = s => String(s == null ? "" : s).trim();
async function container() {
  const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
  await c.createIfNotExists();
  return c;
}
async function readJson(c, name, fallback) {
  const b = c.getBlockBlobClient(name);
  if (!(await b.exists())) return fallback;
  try { return JSON.parse(await streamToString((await b.download()).readableStreamBody)); }
  catch { return fallback; }
}
async function writeDuties(c, arr) {
  const b = c.getBlockBlobClient("duties.json");
  const body = JSON.stringify(arr, null, 2);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, overwrite: true });
}
function rolesStore(obj) { return Array.isArray(obj) ? obj : (obj.assignments || []); }
function qbAreas(store, email) {
  return [...new Set(store.filter(a => clean(a.email).toLowerCase() === email && clean(a.role) === "quarterback")
    .map(a => clean(a.area)).filter(Boolean))];
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isAdmin = roles.includes("superadmin") || roles.includes("admin");
    const isQB = roles.includes("quarterback");
    if (!email) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = await container();
    const duties = await readJson(c, "duties.json", []);
    const rstore = rolesStore(await readJson(c, "roles.json", []));
    const manageable = isAdmin ? AREAS.slice() : qbAreas(rstore, email);

    if (req.method === "GET") {
      // Any signed-in role may READ the catalog (callers need it for duty capture, reconcile for the
      // duties panel). manageableAreas is empty for non-managers, so they get a read-only view.
      context.res = { body: { duties, manageableAreas: manageable, allAreas: AREAS } };
      return;
    }

    if (req.method === "POST") {
      if (!isAdmin && !isQB) { context.res = { status: 403, body: { error: "Not authorized to manage duties." } }; return; }
      const body = req.body || {};
      const op = clean(body.op).toLowerCase();

      if (op === "add" || op === "add_many") {
        const incoming = op === "add" ? [body.entry || {}] : (Array.isArray(body.items) ? body.items : []);
        if (!incoming.length) { context.res = { status: 400, body: { error: "Nothing to add." } }; return; }
        let added = 0, dupes = 0, outOfScope = 0, invalid = 0;
        const rejected = [], flagged = [];
        for (const raw of incoming) {
          const d = { area: clean(raw.area), name: clean(raw.name), description: clean(raw.description) };
          if (!d.area || !d.name) { invalid++; rejected.push(`(blank): missing area or duty name`); continue; }
          if (!AREAS.includes(d.area)) { invalid++; rejected.push(`"${d.name}": unrecognized area "${d.area}" — check the spelling`); continue; }
          if (!manageable.includes(d.area)) { outOfScope++; rejected.push(`"${d.name}": ${d.area} is outside your areas`); continue; }
          const dup = dupOf(duties, d);
          if (dup) { dupes++; flagged.push(`"${d.name}" (${d.area}) looks like a duplicate of "${dup.match.name}" — same ${dup.field}`); continue; }
          duties.push(d); added++;
        }
        if (added > 0) await writeDuties(c, duties);
        context.res = { body: { ok: true, added, dupes, outOfScope, invalid, rejected, flagged, duties } };
        return;
      }

      if (op === "remove") {
        const d = { area: clean((body.entry || {}).area), name: clean((body.entry || {}).name) };
        if (!manageable.includes(d.area)) { context.res = { status: 403, body: { error: "That area is outside your scope." } }; return; }
        const before = duties.length;
        const next = duties.filter(x => !(clean(x.area) === d.area && norm(x.name) === norm(d.name)));
        if (next.length === before) { context.res = { status: 404, body: { error: "Duty not found." } }; return; }
        await writeDuties(c, next);
        context.res = { body: { ok: true, duties: next } };
        return;
      }

      context.res = { status: 400, body: { error: "op must be add, add_many, or remove." } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
