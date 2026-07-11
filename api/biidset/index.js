// Fetch the set of user_ids that CURRENTLY exist in Better Impact, and cache it so a de-dup
// resolution session works against one consistent snapshot. This is what makes the merge safe:
// when two records in a cluster are BOTH still live in BI, we must NOT merge them (they are distinct
// accounts as far as BI is concerned) — the BI team resolves that upstream. retireInto enforces the
// rule, but only if it is handed an accurate id-set, which this produces.
//
//   GET  /api/biidset            -> return the cached snapshot { count, fetchedAt, ageMinutes }
//   POST /api/biidset            -> pull BI fresh, cache it, return the new snapshot
//
// The id-set itself (which can be thousands of ids) is stored server-side in a blob; the resolve
// endpoint reads it. Clients only see counts/age, never the raw list. Superadmin only. A POST hits
// the live BI API, so it is a deliberate action — never fired automatically.
const { BlobServiceClient } = require("@azure/storage-blob");
const { getContainer, streamToString } = require("../shared/store");
const { fetchAllUsers } = require("../sync/bi");
const { normalize } = require("../sync/fields");
const { upsertNormalized } = require("../shared/biupsert");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const SNAPSHOT_BLOB = "bi-idset-snapshot.json";
const BI_USER = process.env.BI_API_USER;
const BI_PASS = process.env.BI_API_PASS;
const BI_BASE = process.env.BI_API_BASE || "https://api.betterimpact.com/v1/enterprise/users/";

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

async function readSnapshot(container) {
  try {
    const b = container.getBlockBlobClient(SNAPSHOT_BLOB);
    if (!(await b.exists())) return null;
    const txt = await streamToString((await b.download()).readableStreamBody);
    return JSON.parse(txt);
  } catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const roles = (getPrincipal(req) || {}).userRoles || [];
    if (!roles.includes("superadmin")) { context.res = { status: 403, body: { error: "Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }
    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const snap = await readSnapshot(container);
      if (!snap) { context.res = { body: { present: false } }; return; }
      const ageMinutes = Math.round((Date.now() - new Date(snap.fetchedAt).getTime()) / 60000);
      context.res = { body: { present: true, count: (snap.ids || []).length, fetchedAt: snap.fetchedAt, ageMinutes } };
      return;
    }

    // POST -> pull BI fresh: (1) cache the id-set for the both-in-BI safety check, and (2) upsert the
    // pulled records into the workspace — refresh existing people's identity/contact from BI and create
    // anyone in BI but not yet in the app as Unassigned. All reconciliation/call/accept work and no-BI
    // write-ins are preserved, and un-pushed caller contact edits are left intact. Pass { idsOnly: true }
    // to only refresh the id-set (skip the volunteer upsert).
    if (!BI_USER || !BI_PASS) { context.res = { status: 500, body: { error: "BI_API_USER / BI_API_PASS not set." } }; return; }
    const idsOnly = (req.body && req.body.idsOnly === true) || req.query.idsOnly === "1";
    const ids = [], normalized = [];
    const { pages, total } = await fetchAllUsers({
      base: BI_BASE, user: BI_USER, pass: BI_PASS, pageSize: 250, maxPages: 250,
      onBatch: (users) => {
        for (const u of users) {
          if (!u || u.user_id == null) continue;
          ids.push(String(u.user_id));
          if (!idsOnly) normalized.push(normalize(u));
        }
      },
    });
    const fetchedAt = new Date().toISOString();
    const snapshot = { fetchedAt, ids, biTotal: total, pages };
    await container.getBlockBlobClient(SNAPSHOT_BLOB).upload(JSON.stringify(snapshot), Buffer.byteLength(JSON.stringify(snapshot)), { overwrite: true });

    // Upsert the pulled records into the live workspace (unless id-set-only was requested).
    let upsert = null;
    if (!idsOnly) upsert = await upsertNormalized(container, normalized, { protectEdits: true });
    context.res = { body: { present: true, count: ids.length, fetchedAt, ageMinutes: 0, biTotal: total, pages, upsert } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
