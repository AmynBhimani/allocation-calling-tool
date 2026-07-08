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
//   /api/reshard?cleanup=1&dry=1  -> AFTER flipping SHARDS_PER_REGION + restart, preview the stale layout to remove
//   /api/reshard?cleanup=1        -> delete the stale layout (safe: refuses if the active layout is empty)
//
// Standard reshard flow: (1) ?to=N, (2) set SHARDS_PER_REGION=N and let the app restart, (3) verify a
// caller's list loads, (4) ?cleanup=1&dry=1 then ?cleanup=1 to drop the old layout. To roll back before
// step 4, just set SHARDS_PER_REGION back and restart (the old layout is still there). After step 4,
// roll back with ?to=1 rather than only flipping the env var, since the old layout is now gone.
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

    // Cleanup: AFTER a reshard + cutover, remove the now-stale OTHER layout so only the active one (per
    // the current SHARDS_PER_REGION) remains — this is what stops a reshard leftover from ever being
    // double-read again. Refuses to delete a region's stale blobs unless that region's ACTIVE layout
    // actually holds data, so a mis-flipped env var can never wipe the only copy. Preview: ?cleanup=1&dry=1
    if (req.query && (req.query.cleanup === "1" || req.query.cleanup === "true")) {
      const dry = req.query.dry === "1" || req.query.dry === "true";
      const legacyName = (r) => `volunteers-${r}.json`;
      const shardName = (r, b) => `volunteers-${r}-${b}.json`;
      const report = [];
      for (const region of regions) {
        const active = new Set(SHARDS === 1 ? [legacyName(region)] : Array.from({ length: SHARDS }, (_, b) => shardName(region, b)));
        const legRe = new RegExp(`^volunteers-${region}\\.json$`);
        const bkRe = new RegExp(`^volunteers-${region}-\\d+\\.json$`);
        const existing = [];
        for await (const b of container.listBlobsFlat({ prefix: `volunteers-${region}` })) {
          if (legRe.test(b.name) || bkRe.test(b.name)) existing.push(b.name);
        }
        const stale = existing.filter(n => !active.has(n)).sort();
        const { records } = await readRegion(container, region);   // reads the ACTIVE layout for current SHARDS
        const activeCount = records.length;
        let deleted = [], skipped = false, reason;
        if (!stale.length) { reason = "already clean — only the active layout is present"; }
        else if (activeCount === 0) { skipped = true; reason = "REFUSED: active layout is empty — deleting the stale layout could destroy the only copy. Check that SHARDS_PER_REGION matches the layout you migrated to."; }
        else if (dry) { reason = `would delete ${stale.length} stale blob(s)`; }
        else { for (const n of stale) { try { await container.getBlockBlobClient(n).deleteIfExists(); deleted.push(n); } catch {} } reason = `deleted ${deleted.length} stale blob(s)`; }
        report.push({ region, activeLayout: SHARDS === 1 ? "legacy single file" : `${SHARDS} buckets`, activeCount, stale, deleted, skipped, reason });
      }
      context.res = { body: { cleanup: true, dryRun: dry, currentShardsPerRegion: SHARDS, regions: report,
        note: dry ? "Preview only — nothing deleted. Re-run with &cleanup=1 (drop &dry) to remove the stale layout." : "Stale layout removed for every region whose active layout was verified non-empty." } };
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
