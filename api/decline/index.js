// Self-service decline — the reverse of api/confirm. The acceptance email carries a per-person link with
// a decline_token; clicking it withdraws the volunteer. Anonymous, exactly like api/confirm (volunteers
// aren't logged in): it never returns 401/403 (those trigger the SWA login redirect); bad links get 400.
//
// The withdraw MIRRORS api/accepted's withdraw exactly (clear duty -> un-accept/reopen -> mark Withdrew),
// so a self-decline lands them in the same state an admin withdraw would. Clearing the duty sets every
// event_assignments row back to pending, which is what "on the lineup" reads from — so it also takes them
// off any lineup, as required. via="self-decline" distinguishes it in the activity log.
const crypto = require("crypto");
const { getContainer, readRegion, mutateVolunteer, REGIONS } = require("../shared/store");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

function tokenMatch(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

function selfWithdraw(v) {
  const now = new Date().toISOString();
  v.activity_log = v.activity_log || [];
  // clear duty + drop every row off the lineup (back to pending)
  for (const r of (Array.isArray(v.event_assignments) ? v.event_assignments : [])) { if (r) { r.duty = ""; r.state = "pending"; } }
  v.assigned_duty = null;
  // un-accept (reopen), same field changes as api/accepted's unaccept
  v.activity_log.push({ ts: now, actor: "self-decline", action: "reopen", from: v.call_outcome || null, via: "self-decline" });
  if (v.ivol_entered) v.bi_correction_needed = true;
  v.call_done = true; v.call_outcome = "Withdrew"; v.ivol_ready = false;
  v.confirm_token = null; v.confirm_sent_at = null; v.confirmed_at = null;
  // mark Withdrew + stamp the self-decline (declined_at drives the "already withdrawn" landing state and
  // idempotency; decline_token is deliberately kept so a second click shows that friendly state, not an error)
  v.declined_at = now;
  v.activity_log.push({ ts: now, actor: "self-decline", action: "outcome", outcome: "Withdrew", via: "self-decline" });
}

module.exports = async function (context, req) {
  try {
    if (!CONN) { context.res = { status: 500, body: { ok: false, error: "Not configured." } }; return; }
    const u = String((req.query && req.query.u) || (req.body && req.body.u) || "").trim();
    const r = String((req.query && req.query.r) || (req.body && req.body.r) || "").trim();
    const t = String((req.query && req.query.t) || (req.body && req.body.t) || "").trim();
    if (!u || !REGIONS.includes(r) || !t) { context.res = { status: 400, body: { ok: false, error: "This link is invalid." } }; return; }

    const container = await getContainer(DATA_CONTAINER);

    if (req.method === "GET") {
      const { records } = await readRegion(container, r);
      const v = records.find(x => String(x.user_id) === u);
      if (!v || !v.decline_token || !tokenMatch(t, v.decline_token)) {
        context.res = { status: 400, body: { ok: false, error: "This link is invalid or has expired. Please contact the Volunteer Experience Team." } };
        return;
      }
      context.res = { body: { ok: true, first: v.first || "", area: v.final_area || "your assigned area", declined: !!v.declined_at } };
      return;
    }

    if (req.method === "POST") {
      let already = false, payload = null;
      const result = await mutateVolunteer(container, r, isNaN(+u) ? u : +u, (v) => {
        if (!v.decline_token || !tokenMatch(t, v.decline_token)) return { bad: true };
        if (v.declined_at) already = true; else selfWithdraw(v);
        payload = { first: v.first || "", area: v.final_area || "your assigned area" };
      });
      if (result.notFound || (result.extra && result.extra.bad)) {
        context.res = { status: 400, body: { ok: false, error: "This link is invalid or has expired. Please contact the Volunteer Experience Team." } };
        return;
      }
      if (!result.ok) { context.res = { status: 200, body: { ok: false, error: "Please try again in a moment." } }; return; }
      context.res = { body: { ok: true, already, first: payload.first, area: payload.area } };
      return;
    }

    context.res = { status: 405, body: { ok: false, error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { ok: false, error: "Something went wrong. Please contact the Volunteer Experience Team." } };
  }
};
