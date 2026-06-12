module.exports = async function (context, req) {
  context.res = { body: { ok: true, node: process.version, time: new Date().toISOString() } };
};
