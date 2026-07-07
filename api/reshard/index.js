// Reshards the volunteer data: rewrites each region into `to` blobs, reading the CURRENT layout.
// Run this DURING A CALLING LULL, then flip the SHARDS_PER_REGION app setting to match `to` and let
// the app restart. It never deletes the source layout, so setting SHARDS_PER_REGION back is an
// instant, lossless rollback. Gated by RESHARD_TRIGGER_KEY (header x-reshard-key or ?key=) or a
// logged-in Super Admin.
//
// Usage (Super Admin in a browser, or curl with the key):
//   /api/reshard?dry=1            -> preview record counts per region, writes nothing
//   /api/reshard?to=8             -> split every region into 8 shards
//   /api/reshard?to=8&region=Edmonton  -> just one region
//   /api/reshard?to=1             -> collapse back to the single legacy blob (for rollback)
const { getContainer, reshardRegion, REGIONS, readRegion, SHARDS } = require("../shared/store");

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}

module.exports = async function (context, req) {
  try {
    const need = process.env.RESHARD_TRIGGER_KEY;
    const got = req.headers["x-reshard-key"] || (req.query && req.query.key) || "";
    const roles = (getPrincipal(req) || {}).userRoles || [];
    const ok = roles.includes("superadmin") || (need && got === need);
    if (!ok) { context.res = { status: 403, body: { error: "Super Admin or the reshard key is required." } }; return; }

    const container = await getContainer(process.env.DATA_CONTAINER || "tool-data");
    const only = req.query && req.query.region;
    const regions = only ? REGIONS.filter(r => r === only) : REGIONS;
    if (only && !regions.length) { context.res = { status: 400, body: { error: `Unknown region "${only}".` } }; return; }

    // Dry run: report what's there now, write nothing.
    if (req.query && (req.query.dry === "1" || req.query.dry === "true")) {
      const preview = [];
      for (const region of regions) { const { records } = await readRegion(container, region); preview.push({ region, total: records.length }); }
      context.res = { body: { dryRun: true, currentShardsPerRegion: SHARDS, regions: preview } };
      return;
    }

    const to = parseInt(req.query && req.query.to, 10);
    if (!Number.isInteger(to) || to < 1 || to > 64) { context.res = { status: 400, body: { error: "Pass ?to=N (1–64), the target number of shards per region. Use ?dry=1 to preview." } }; return; }

    const results = [];
    for (const region of regions) results.push(await reshardRegion(container, region, to));
    const total = results.reduce((s, r) => s + r.total, 0);

    context.res = {
      body: {
        ok: true, readAtShardsPerRegion: SHARDS, wroteTo: to, totalRecords: total, regions: results,
        next: to === 1
          ? "Rollback written. Now set SHARDS_PER_REGION=1 (or remove it) and let the app restart."
          : `Now set the app setting SHARDS_PER_REGION=${to} and let the app restart. Verify a caller's list loads, then resume calling. The original files are untouched — to roll back, set SHARDS_PER_REGION back and restart.`,
      }
    };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
