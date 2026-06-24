module.exports = async function (context, req) {
  // Read-only diagnostic. Reports the *names* of the blob containers this environment is wired to
  // (never the connection string) so a sandbox can be confirmed isolated from production BEFORE any
  // write is attempted. Container names are not secrets — they grant no access without the storage
  // credential, which is never exposed here.
  const host = (req.headers && (req.headers["x-forwarded-host"] || req.headers["host"])) || null;
  context.res = {
    body: {
      ok: true,
      node: process.version,
      time: new Date().toISOString(),
      host,
      storage: {
        dataContainer: process.env.DATA_CONTAINER || "tool-data",
        configContainer: process.env.CONFIG_CONTAINER || "app-config",
        responsesContainer: process.env.RESPONSES_CONTAINER || "reviewer-responses",
        responsesStorageConfigured: !!process.env.RESPONSES_STORAGE,
      },
    },
  };
};
