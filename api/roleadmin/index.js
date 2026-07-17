const { BlobServiceClient } = require("@azure/storage-blob");
const { scopesFor } = require("../shared/store");   // one definition of "which cells do you hold?"

const CONN = process.env.RESPONSES_STORAGE;
const CONFIG_CONTAINER = process.env.CONFIG_CONTAINER || "app-config";

// Roles manageable here. superadmin is excluded — controlled by SUPER_ADMIN_EMAILS so the tool
// can never be locked out via the role store.
const MANAGEABLE = ["admin", "dutyteam", "quarterback", "caller", "ivoladmin", "leadership"];
const REGIONS = ["BC", "Prairies", "Edmonton"];
const AREAS = [
  "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
  "Seniors & Mobility", "Food Services", "Layout & Logistics",
  "Registration & Access", "Medical Services", "Diverse Abilities Support",
  "Finance & Procurement", "Environmental Sustainability", "Memorabilia & Design", "Jamati Preparation"
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
async function readEvents(c) {
  const b = c.getBlockBlobClient("events.json");
  if (!(await b.exists())) return [];
  try { const o = JSON.parse(await streamToString((await b.download()).readableStreamBody)); return Array.isArray(o) ? o : (o.events || []); }
  catch { return []; }
}
function sameEntry(a, b) {
  return clean(a.email).toLowerCase() === clean(b.email).toLowerCase()
    && clean(a.role) === clean(b.role)
    && clean(a.area) === clean(b.area)
    && clean(a.region) === clean(b.region)
    && clean(a.event) === clean(b.event);
}
// The area×region scopes a given email holds for a given role.
function scopeHas(scopes, area, region) {
  return scopes.some(s => s.area === area && s.region === region);
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const isSuper = roles.includes("superadmin") || roles.includes("admin"); // admin mirrors Super Admin (manages all MANAGEABLE roles; cannot grant superadmin)
    const isQuarterback = roles.includes("quarterback");
    if (!isSuper && !isQuarterback) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = await container();
    const store = await readStore(c);
    const events = await readEvents(c);
    const didars = events.filter(ev => !ev.parent && ev.active !== false)
      .map(ev => ({ id: clean(ev.id), name: clean(ev.name), regions: (Array.isArray(ev.regions) ? ev.regions : []).map(clean).filter(Boolean) }));
    const regionsForEvent = (id) => { const d = didars.find(x => x.id === id); return d ? d.regions.slice() : []; };
    const eventName = (id) => { const d = didars.find(x => x.id === id); return d ? d.name : id; };
    const myScopes = isQuarterback ? scopesFor(store, email, "quarterback") : [];

    if (req.method === "GET") {
      if (isSuper) {
        context.res = { body: { assignments: store, meta: { roles: MANAGEABLE, regions: REGIONS, areas: AREAS, events: didars } } };
        return;
      }
      // Quarterback: only their own scopes + the callers within those scopes.
      const myAreas = [...new Set(myScopes.map(s => s.area))];
      const myRegions = [...new Set(myScopes.map(s => s.region))];
      const myEvents = didars.filter(d => d.regions.some(r => myRegions.includes(r)));
      const callers = store.filter(a => clean(a.role) === "caller" && scopeHas(myScopes, clean(a.area), clean(a.region)));
      context.res = { body: { assignments: callers, scopes: myScopes,
        meta: { roles: ["caller"], regions: myRegions, areas: myAreas, events: myEvents } } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const op = clean(body.op).toLowerCase();
      const e = body.entry || {};
      const role = clean(e.role).toLowerCase();
      const eventId = clean(e.event);
      const reqEmail = clean(e.email).toLowerCase();
      let areas = Array.isArray(e.areas) ? e.areas.map(clean).filter(Boolean) : [];
      if (!areas.length && clean(e.area)) areas = [clean(e.area)];
      const evRegions = regionsForEvent(eventId);   // regions covered by the chosen Didar

      // ---- Quarterback path: may only manage CALLERS within their own area×region scopes ----
      if (!isSuper) {
        if (role !== "caller") { context.res = { status: 403, body: { error: "Quarterbacks can only manage callers." } }; return; }
        if (!eventId || !areas.length) { context.res = { status: 400, body: { error: "Pick an event and at least one area." } }; return; }
        if (!evRegions.length) { context.res = { status: 400, body: { error: "That event has no regions set yet." } }; return; }
        // The event may cover regions this QB doesn't manage (other QBs own those). Require that at
        // least ONE area×region combo is in scope; the expansion below only creates the in-scope ones.
        const anyInScope = evRegions.some(r => areas.some(a => scopeHas(myScopes, a, r)));
        if (!anyInScope) { context.res = { status: 403, body: { error: "None of those areas are in your scope for that event." } }; return; }
      }

      let assignments = store;

      if (op === "add") {
        if (!reqEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(reqEmail)) {
          context.res = { status: 400, body: { error: "A valid email is required." } }; return;
        }
        if (isSuper && !MANAGEABLE.includes(role)) {
          context.res = { status: 400, body: { error: `Role must be one of: ${MANAGEABLE.join(", ")}. (Super Admin is managed via app settings.)` } }; return;
        }
        // iVolunteer Administrator and Leadership are org-wide roles: no event/region scope, one entry.
        const GLOBAL_ROLES = ["ivoladmin", "leadership"];
        const isGlobal = GLOBAL_ROLES.includes(role);
        if (!isGlobal) {
          if (!eventId) { context.res = { status: 400, body: { error: "Tag this person to an event." } }; return; }
          if (!evRegions.length) { context.res = { status: 400, body: { error: "That event has no regions set — set them on the Events screen first." } }; return; }
        }
        if (role === "quarterback" || role === "caller") {
          if (!areas.length) { context.res = { status: 400, body: { error: "Pick at least one area." } }; return; }
          if (areas.some(a => !AREAS.includes(a))) { context.res = { status: 400, body: { error: "One or more areas are invalid." } }; return; }
        }
        // Expand the event tag into one role entry per region it covers (× area for qb/caller),
        // stamping the event so the screen can group by it. The region on each row drives the data wall.
        // A quarterback only creates the area×region combos within their own scope; out-of-scope
        // regions of the same event belong to other quarterbacks. Global roles get a single scopeless row.
        const toAdd = [];
        const allow = (a, r) => isSuper || scopeHas(myScopes, a, r);
        if (isGlobal) {
          toAdd.push({ email: reqEmail, role });
        } else if (role === "quarterback" || role === "caller") {
          for (const r of evRegions) for (const a of areas) if (allow(a, r)) toAdd.push({ email: reqEmail, role, area: a, region: r, event: eventId });
        } else {
          for (const r of evRegions) toAdd.push({ email: reqEmail, role, region: r, event: eventId });
        }
        let added = 0, dupes = 0;
        for (const en of toAdd) {
          if (assignments.some(a => sameEntry(a, en))) { dupes++; continue; }
          assignments.push(en); added++;
        }
        if (added === 0) { context.res = { status: 409, body: { error: "Those assignments already exist." } }; return; }
        await writeStore(c, assignments);
        context.res = { body: { ok: true, added, dupes, eventName: eventName(eventId), assignments: scopedView(assignments, isSuper, myScopes) } };
        return;
      }

      if (op === "remove") {
        // Remove a whole event-tag group (email+role+event[, area]); legacy rows fall back to region match.
        const region = clean(e.region);
        const before = assignments.length;
        assignments = assignments.filter(a => {
          if (clean(a.email).toLowerCase() !== reqEmail || clean(a.role) !== role) return true; // keep
          if (eventId) {
            if (clean(a.event) !== eventId) return true;
            if (areas.length && !areas.includes(clean(a.area))) return true;
            return false; // matches the group -> drop
          }
          if (region && clean(a.region) !== region) return true;
          if (areas.length && !areas.includes(clean(a.area))) return true;
          return false;
        });
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
