const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";

// Roles manageable here. superadmin is excluded — controlled by SUPER_ADMIN_EMAILS so the tool
// can never be locked out via the role store.
const MANAGEABLE = ["admin", "dutyteam", "quarterback", "caller"];
const REGIONS = ["BC", "Prairies", "Edmonton"];
const AREAS = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics",
  "Registration & Access", "Medical Services",
  "Finance & Procurement", "Environmental Sustainability"
];

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
// The area×region scopes a given email holds for a given role.
function scopesFor(store, email, role) {
  return store.filter(a => clean(a.email).toLowerCase() === email && clean(a.role) === role)
    .map(a => ({ area: clean(a.area), region: clean(a.region) }));
}
function scopeHas(scopes, area, region) {
  return scopes.some(s => s.area === area && s.region === region);
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin");
    const isQuarterback = roles.includes("quarterback");
    if (!isSuper && !isQuarterback) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = await container();
    const store = await readStore(c);
    const myScopes = isQuarterback ? scopesFor(store, email, "quarterback") : [];

    if (req.method === "GET") {
      if (isSuper) {
        context.res = { body: { assignments: store, meta: { roles: MANAGEABLE, regions: REGIONS, areas: AREAS } } };
        return;
      }
      // Quarterback: only their own scopes + the callers within those scopes.
      const myAreas = [...new Set(myScopes.map(s => s.area))];
      const myRegions = [...new Set(myScopes.map(s => s.region))];
      const callers = store.filter(a => clean(a.role) === "caller" && scopeHas(myScopes, clean(a.area), clean(a.region)));
      context.res = { body: { assignments: callers, scopes: myScopes,
        meta: { roles: ["caller"], regions: myRegions, areas: myAreas } } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const op = clean(body.op).toLowerCase();
      const e = body.entry || {};
      const role = clean(e.role).toLowerCase();
      const region = clean(e.region);
      const reqEmail = clean(e.email).toLowerCase();
      let areas = Array.isArray(e.areas) ? e.areas.map(clean).filter(Boolean) : [];
      if (!areas.length && clean(e.area)) areas = [clean(e.area)];

      // ---- Quarterback path: may only manage CALLERS within their own area×region scopes ----
      if (!isSuper) {
        if (role !== "caller") { context.res = { status: 403, body: { error: "Quarterbacks can only manage callers." } }; return; }
        if (!region || !areas.length) { context.res = { status: 400, body: { error: "Region and at least one area are required." } }; return; }
        const outOfScope = areas.filter(a => !scopeHas(myScopes, a, region));
        if (outOfScope.length) { context.res = { status: 403, body: { error: `Outside your areas: ${outOfScope.join(", ")}` } }; return; }
      }

      let assignments = store;

      if (op === "add") {
        if (!reqEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reqEmail)) {
          context.res = { status: 400, body: { error: "A valid email is required." } }; return;
        }
        if (isSuper && !MANAGEABLE.includes(role)) {
          context.res = { status: 400, body: { error: `Role must be one of: ${MANAGEABLE.join(", ")}. (Super Admin is managed via app settings.)` } }; return;
        }
        if (role === "dutyteam" || role === "quarterback" || role === "caller") {
          if (!region || !REGIONS.includes(region)) { context.res = { status: 400, body: { error: "A valid region is required for this role." } }; return; }
        }
        if (role === "quarterback" || role === "caller") {
          if (!areas.length) { context.res = { status: 400, body: { error: "Pick at least one area." } }; return; }
          if (areas.some(a => !AREAS.includes(a))) { context.res = { status: 400, body: { error: "One or more areas are invalid." } }; return; }
        }
        const toAdd = [];
        if (role === "quarterback" || role === "caller") {
          for (const a of areas) toAdd.push({ email: reqEmail, role, area: a, region });
        } else {
          const en = { email: reqEmail, role }; if (region) en.region = region; toAdd.push(en);
        }
        let added = 0, dupes = 0;
        for (const en of toAdd) {
          if (assignments.some(a => sameEntry(a, en))) { dupes++; continue; }
          assignments.push(en); added++;
        }
        if (added === 0) { context.res = { status: 409, body: { error: "Those assignments already exist." } }; return; }
        await writeStore(c, assignments);
        context.res = { body: { ok: true, added, dupes, assignments: scopedView(assignments, isSuper, myScopes) } };
        return;
      }

      if (op === "remove") {
        const entry = { email: reqEmail, role, area: areas[0] || "", region };
        if (!entry.area) delete entry.area;
        if (!entry.region) delete entry.region;
        const before = assignments.length;
        assignments = assignments.filter(a => !sameEntry(a, entry));
        if (assignments.length === before) { context.res = { status: 404, body: { error: "No matching assignment found." } }; return; }
        await writeStore(c, assignments);
        context.res = { body: { ok: true, assignments: scopedView(assignments, isSuper, myScopes) } };
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

// Return the full list to Super Admin; to a quarterback, only callers within their scopes.
function scopedView(assignments, isSuper, myScopes) {
  if (isSuper) return assignments;
  return assignments.filter(a => clean(a.role) === "caller" && scopeHas(myScopes, clean(a.area), clean(a.region)));
}
