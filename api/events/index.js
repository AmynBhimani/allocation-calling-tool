// Events config: the multi-event structure. Two tiers — Didar (top level) and Session (under a Didar).
// Stored as events.json in the app-config container, beside roles.json.
// GET is readable by any signed-in role (caller / reconcile / reports need it); writes are super/admin only.
const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";

// Seeded automatically the first time the blob is missing, so the two Didars exist right after deploy.
const DEFAULT_EVENTS = [
  { id: "bc_didar", name: "British Columbia Didar", parent: null, regions: ["BC"], jamatkhanas: [], active: true },
  { id: "pe_didar", name: "Prairies / Edmonton Didar", parent: null, regions: ["Prairies", "Edmonton"], jamatkhanas: [], active: true },
];

const VALID_REGIONS = ["BC", "Prairies", "Edmonton"];

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
function clean(s) { return String(s == null ? "" : s).trim(); }
function slug(s) {
  return clean(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "event";
}
function parseJk(v) {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  return clean(v).split(/[\n,]/).map(clean).filter(Boolean);
}
function parseRegions(v) {
  const arr = Array.isArray(v) ? v : clean(v).split(/[\n,]/);
  return [...new Set(arr.map(clean).filter(x => VALID_REGIONS.includes(x)))];
}
function norm(e) {
  return {
    id: clean(e.id),
    name: clean(e.name),
    parent: e.parent ? clean(e.parent) : null,
    regions: parseRegions(e.regions),
    jamatkhanas: parseJk(e.jamatkhanas),
    active: e.active !== false,
  };
}
async function container() {
  if (!CONN) throw new Error("Storage not configured.");
  const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
  await c.createIfNotExists();
  return c;
}
async function readEvents(c) {
  const b = c.getBlockBlobClient("events.json");
  if (!(await b.exists())) return null;
  try {
    const obj = JSON.parse(await streamToString((await b.download()).readableStreamBody));
    return (Array.isArray(obj) ? obj : (obj.events || [])).map(norm);
  } catch { return []; }
}
async function writeEvents(c, arr) {
  const b = c.getBlockBlobClient("events.json");
  const body = JSON.stringify(arr, null, 2);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, overwrite: true });
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    const canWrite = roles.includes("superadmin") || roles.includes("admin");
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = await container();
    let events = await readEvents(c);
    if (!events || events.length === 0) { events = DEFAULT_EVENTS.map(norm); await writeEvents(c, events); } // seed base Didars if config is missing OR empty

    if (req.method === "GET") {
      context.res = { body: { events, canManage: canWrite } };
      return;
    }

    if (req.method === "POST") {
      if (!canWrite) { context.res = { status: 403, body: { error: "Not authorized to manage events." } }; return; }
      const body = req.body || {};
      const op = clean(body.op).toLowerCase();

      if (op === "add") {
        const e = norm(body.entry || {});
        if (!e.name) { context.res = { status: 400, body: { error: "Name is required." } }; return; }
        if (events.some(x => x.name.toLowerCase() === e.name.toLowerCase())) {
          context.res = { status: 409, body: { error: "An event with that name already exists." } }; return;
        }
        if (e.parent) {
          const p = events.find(x => x.id === e.parent);
          if (!p) { context.res = { status: 400, body: { error: "Parent Didar not found." } }; return; }
          if (p.parent) { context.res = { status: 400, body: { error: "A session can't be nested under another session." } }; return; }
        }
        let base = slug(e.name), id = base, n = 2;
        while (events.some(x => x.id === id)) { id = base + "_" + (n++); }
        e.id = id;
        events.push(e);
        await writeEvents(c, events);
        context.res = { body: { ok: true, events } };
        return;
      }

      if (op === "update") {
        const e = body.entry || {};
        const id = clean(e.id);
        const ev = events.find(x => x.id === id);
        if (!ev) { context.res = { status: 404, body: { error: "Event not found." } }; return; }
        if (e.name !== undefined) {
          const nm = clean(e.name);
          if (!nm) { context.res = { status: 400, body: { error: "Name can't be blank." } }; return; }
          if (events.some(x => x.id !== id && x.name.toLowerCase() === nm.toLowerCase())) {
            context.res = { status: 409, body: { error: "Another event already has that name." } }; return;
          }
          ev.name = nm;
        }
        if (e.jamatkhanas !== undefined) ev.jamatkhanas = parseJk(e.jamatkhanas);
        if (e.regions !== undefined) ev.regions = parseRegions(e.regions);
        if (e.active !== undefined) ev.active = !!e.active;
        await writeEvents(c, events);
        context.res = { body: { ok: true, events } };
        return;
      }

      if (op === "remove") {
        const id = clean(body.id || (body.entry && body.entry.id));
        const ev = events.find(x => x.id === id);
        if (!ev) { context.res = { status: 404, body: { error: "Event not found." } }; return; }
        if (events.some(x => x.parent === id)) {
          context.res = { status: 409, body: { error: "Remove this Didar's sessions first." } }; return;
        }
        events = events.filter(x => x.id !== id);
        await writeEvents(c, events);
        context.res = { body: { ok: true, events } };
        return;
      }

      context.res = { status: 400, body: { error: "op must be add, update, or remove." } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
