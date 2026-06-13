const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";

// Roles that can be managed here. superadmin is intentionally excluded — it is controlled by the
// SUPER_ADMIN_EMAILS app setting so the tool can never be locked out by editing the role store.
const MANAGEABLE = ["admin", "dutyteam", "quarterback", "caller"];
const REGIONS = ["BC", "Prairies", "Edmonton"];
const AREAS = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics",
  "Registration & Access", "Medical Services"
];

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
async function container() {
  const c = BlobServiceClient.fromConnectionString(CONN).getContainerClient(CONFIG_CONTAINER);
  await c.createIfNotExists();
  return c;
}
async function readStore(c) {
  const b = c.getBlockBlobClient("roles.json");
  if (!(await b.exists())) return [];
  try {
    const obj = JSON.parse(await streamToString((await b.download()).readableStreamBody));
    return Array.isArray(obj) ? obj : (obj.assignments || []);
  } catch { return []; }
}
async function writeStore(c, arr) {
  const b = c.getBlockBlobClient("roles.json");
  const body = JSON.stringify(arr, null, 2);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, overwrite: true });
}
function clean(s) { return String(s == null ? "" : s).trim(); }
function sameEntry(a, b) {
  return clean(a.email).toLowerCase() === clean(b.email).toLowerCase()
    && clean(a.role) === clean(b.role)
    && clean(a.area) === clean(b.area)
    && clean(a.region) === clean(b.region);
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const roles = (principal && principal.userRoles) || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = await container();

    if (req.method === "GET") {
      const assignments = await readStore(c);
      context.res = { body: { assignments, meta: { roles: MANAGEABLE, regions: REGIONS, areas: AREAS } } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const op = clean(body.op).toLowerCase();
      const e = body.entry || {};
      const role = clean(e.role).toLowerCase();
      const region = clean(e.region);
      const email = clean(e.email).toLowerCase();
      // areas can come as a single `area` or an array `areas`
      let areas = Array.isArray(e.areas) ? e.areas.map(clean).filter(Boolean) : [];
      if (!areas.length && clean(e.area)) areas = [clean(e.area)];

      let assignments = await readStore(c);

      if (op === "add") {
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          context.res = { status: 400, body: { error: "A valid email is required." } }; return;
        }
        if (!MANAGEABLE.includes(role)) {
          context.res = { status: 400, body: { error: `Role must be one of: ${MANAGEABLE.join(", ")}. (Super Admin is managed via app settings.)` } }; return;
        }
        // region is mandatory for Duty Allocation Team, Quarterback, and Caller
        if (role === "dutyteam" || role === "quarterback" || role === "caller") {
          if (!region || !REGIONS.includes(region)) { context.res = { status: 400, body: { error: "A valid region is required for this role." } }; return; }
        }
        if (role === "quarterback" || role === "caller") {
          if (!areas.length) { context.res = { status: 400, body: { error: "Pick at least one area for a Quarterback/Caller." } }; return; }
          if (areas.some(a => !AREAS.includes(a))) { context.res = { status: 400, body: { error: "One or more areas are invalid." } }; return; }
        }

        // build the entries to add (one per area for QB/caller; one otherwise)
        const toAdd = [];
        if (role === "quarterback" || role === "caller") {
          for (const a of areas) { const en = { email, role, area: a, region }; toAdd.push(en); }
        } else {
          const en = { email, role }; if (region) en.region = region; toAdd.push(en);
        }

        let added = 0, dupes = 0;
        for (const en of toAdd) {
          if (assignments.some(a => sameEntry(a, en))) { dupes++; continue; }
          assignments.push(en); added++;
        }
        if (added === 0) { context.res = { status: 409, body: { error: "Those assignments already exist." } }; return; }
        await writeStore(c, assignments);
        context.res = { body: { ok: true, added, dupes, assignments } };
        return;
      }

      if (op === "remove") {
        const entry = { email, role, area: areas[0] || "", region };
        if (!entry.area) delete entry.area;
        if (!entry.region) delete entry.region;
        const before = assignments.length;
        assignments = assignments.filter(a => !sameEntry(a, entry));
        if (assignments.length === before) { context.res = { status: 404, body: { error: "No matching assignment found." } }; return; }
        await writeStore(c, assignments);
        context.res = { body: { ok: true, assignments } };
        return;
      }

      context.res = { status: 400, body: { error: "op must be 'add' or 'remove'." } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
