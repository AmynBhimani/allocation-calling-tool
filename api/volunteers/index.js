const { BlobServiceClient } = require("@azure/storage-blob");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const REGIONS = ["BC", "Prairies", "Edmonton"];

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
  const svc = BlobServiceClient.fromConnectionString(CONN);
  const c = svc.getContainerClient(DATA_CONTAINER);
  await c.createIfNotExists();
  return c;
}
async function readShard(c, region) {
  const b = c.getBlockBlobClient(`volunteers-${region}.json`);
  if (!(await b.exists())) return [];
  try { return JSON.parse(await streamToString((await b.download()).readableStreamBody)); }
  catch { return []; }
}
async function writeShard(c, region, arr) {
  const b = c.getBlockBlobClient(`volunteers-${region}.json`);
  const body = JSON.stringify(arr);
  await b.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: "application/json" } });
}

// Reconciliation view never exposes contact info (scoped-access principle).
function slim(v) {
  return {
    id: v.user_id, first: v.first, last: v.last, region: v.region, jk: v.ceremony_jk,
    computed: v.computed_area, final: v.final_area, status: v.callable_status,
    affinity: !!v.affinity_flag, leader: !!v.leader_flag, new: !!v.never_reviewed,
    claims: v.conflict_claims || []
  };
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const canRecon = roles.includes("superadmin") || roles.includes("admin") || roles.includes("dutyteam");
    if (!email || !canRecon) { context.res = { status: 403, body: { error: "Not authorized." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    const c = await container();

    if (req.method === "GET") {
      const only = req.query.region;
      const regions = only && REGIONS.includes(only) ? [only] : REGIONS;
      const out = [];
      for (const r of regions) {
        const shard = await readShard(c, r);
        for (const v of shard) out.push(slim(v));
      }
      context.res = { body: { volunteers: out, count: out.length } };
      return;
    }

    if (req.method === "POST") {
      const { user_id, region, final_area } = req.body || {};
      if (user_id == null || !region || !REGIONS.includes(region)) {
        context.res = { status: 400, body: { error: "user_id and a valid region are required." } };
        return;
      }
      const shard = await readShard(c, region);
      const v = shard.find(x => x.user_id === user_id);
      if (!v) { context.res = { status: 404, body: { error: "Volunteer not found in region." } }; return; }

      const hold = final_area === "__hold__" || final_area === null || final_area === "";
      const before = v.final_area;
      v.final_area = hold ? null : final_area;
      v.callable_status = hold ? "Unassigned" : "Stable";
      v.activity_log = v.activity_log || [];
      v.activity_log.push({
        ts: new Date().toISOString(), actor: email, action: "set_final_area",
        from: before || null, to: v.final_area || null
      });
      await writeShard(c, region, shard);
      context.res = { body: { ok: true, volunteer: slim(v) } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
