const crypto = require("crypto");
const { getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

// Constant-time token compare that tolerates length differences.
function tokenMatch(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

module.exports = async function (context, req) {
  // NOTE: this endpoint is intentionally anonymous (volunteers aren't logged in).
  // It never returns 401/403 (those would trigger the SWA login redirect); bad links get 400.
  try {
    if (!CONN) { context.res = { status: 500, body: { ok: false, error: "Not configured." } }; return; }
    const u = String((req.query && req.query.u) || (req.body && req.body.u) || "").trim();
    const r = String((req.query && req.query.r) || (req.body && req.body.r) || "").trim();
    const t = String((req.query && req.query.t) || (req.body && req.body.t) || "").trim();
    if (!u || !REGIONS.includes(r) || !t) { context.res = { status: 400, body: { ok: false, error: "This confirmation link is invalid." } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const { records } = await readRegion(container, r);
      const v = records.find(x => String(x.user_id) === u);
      if (!v || !v.confirm_token || !tokenMatch(t, v.confirm_token)) {
        context.res = { status: 400, body: { ok: false, error: "This confirmation link is invalid or has expired. Please contact your coordinator." } };
        return;
      }
      context.res = { body: { ok: true, first: v.first || "", area: v.final_area || "your assigned area", confirmed: !!v.confirmed_at } };
      return;
    }

    if (req.method === "POST") {
      let already = false, payload = null;
      const result = await mutateVolunteer(container, r, isNaN(+u) ? u : +u, (v) => {
        if (!v.confirm_token || !tokenMatch(t, v.confirm_token)) return { bad: true };
        v.activity_log = v.activity_log || [];
        if (v.confirmed_at) { already = true; }
        else {
          const now = new Date().toISOString();
          v.confirmed_at = now;
          v.call_outcome = "Accepted";
          v.call_done = true;
          v.ivol_ready = true;
          v.activity_log.push({ ts: now, actor: "self-confirm", action: "outcome", outcome: "Accepted", via: "email" });
        }
        payload = { first: v.first || "", area: v.final_area || "your assigned area" };
      });
      if (result.notFound || (result.extra && result.extra.bad)) {
        context.res = { status: 400, body: { ok: false, error: "This confirmation link is invalid or has expired. Please contact your coordinator." } };
        return;
      }
      if (!result.ok) { context.res = { status: 200, body: { ok: false, error: "Please try again in a moment." } }; return; }
      context.res = { body: { ok: true, already, first: payload.first, area: payload.area } };
      return;
    }

    context.res = { status: 405, body: { ok: false, error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { ok: false, error: "Something went wrong. Please contact your coordinator." } };
  }
};
