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
// Settings are stored per event: { events: { [eventId]: settings }, default: settings }. An older flat
// blob (settings at the top level) is read as the shared `default`, so nothing is lost on upgrade and an
// event with no saved settings falls back to it.
function normStore(raw) {
  if (!raw || typeof raw !== "object") return { events: {}, default: null };
  if (raw.events && typeof raw.events === "object" && !Array.isArray(raw.events)) return { events: raw.events, default: raw.default || null };
  return { events: {}, default: raw };   // legacy flat settings become the default
}
async function loadStore(b) {
  if (!(await b.exists())) return { events: {}, default: null };
  try { return normStore(JSON.parse(await streamToString((await b.download()).readableStreamBody))); }
  catch { return { events: {}, default: null }; }
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
      const store = await loadStore(b);
      const ev = (req.query && req.query.event) || "";
      const s = ev ? (store.events[ev] || store.default) : store.default;   // event-specific, else the shared default
      context.res = { body: { settings: s || null, event: ev || null } };
      return;
    }

    if (req.method === "POST") {
      const settings = (req.body && req.body.settings) || null;
      const ev = (req.body && req.body.event) || "";
      if (!settings || typeof settings !== "object") { context.res = { status: 400, body: { error: "No settings supplied." } }; return; }
      const store = await loadStore(b);
      const rec = { ...settings, savedAt: new Date().toISOString(), savedBy: (principal && principal.userDetails) || "" };
      if (ev) store.events[ev] = rec; else store.default = rec;   // per-event save, or the shared default
      const body = JSON.stringify(store, null, 2);
      await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" }, overwrite: true });
      context.res = { body: { ok: true, savedAt: rec.savedAt, event: ev || null } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
