// Accepted Volunteers: everyone who has accepted a duty (call outcome Accepted, self-confirm, or iVol-ready),
// scoped to what the viewer is allowed to see. Super Admin & Leadership see all; Admin & Duty Team see
// their event regions; Quarterbacks see only their area×region. Leadership (do-not-allocate) is excluded.
const { getContainer, readRegion, mutateVolunteer, REGIONS, readRolesStore, allowedRegionsFor, readDidars } = require("../shared/store");
const { isAcceptedVolunteer, dutiesOf } = require("../shared/rollup");
const { seedEventAssignments } = require("../shared/status");
const { repool } = require("../shared/repool");
const { AREAS } = require("../shared/duties");

const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";
const clean = (s) => String(s == null ? "" : s).trim();

function getPrincipal(req) {
  const h = req.headers["x-ms-client-principal"];
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
}
function ageOf(v) {
  if (v.age != null && Number.isFinite(Number(v.age))) return Number(v.age);
  if (!v.birthday) return null;
  const d = new Date(v.birthday); if (isNaN(d)) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 130 ? a : null;
}
const iffOf = (v) => !!v.interfaith || v.list === "IFF";
const diverseOf = (v) => /diverse/i.test(String(v.list || ""));
// Quarterback / caller area×region scopes from the role store.
const scopesFor = (store, email, role) => store
  .filter(a => clean(a.email).toLowerCase() === email && clean(a.role) === role && clean(a.area))
  .map(a => ({ area: clean(a.area), region: clean(a.region) }));
const inScope = (scopes, area, region) => scopes.some(s => s.area === area && s.region === region);
function acceptedAt(v) {
  let when = null;
  for (const e of (v.activity_log || [])) if (e.action === "outcome" && e.outcome === "Accepted") when = e.ts;
  return when;
}

// ---- Undoing an acceptance (Duty Team / Admin / Super Admin) -------------------------------------
// The volunteer accepted, then told someone they can't. Three endings, and which one applies is the
// volunteer's answer, not ours: they've withdrawn entirely; they'd serve, just not in this area (refer
// them on); or they simply don't want the area they were given (back to the pool for re-allocation).
const ACTIONS = ["withdraw", "decline_refer", "repool"];

// Un-accept, exactly as api/calls' reopen does. ivol_ready is the half of isAcceptedVolunteer that
// isn't the activity log, so leaving it set would keep them "accepted" no matter what outcome we
// write afterwards. api/calls' Declined-referred branch doesn't clear it because a caller can only
// reach that branch through a reopen; we do both in one step, so we must clear it ourselves.
// ivol_entered is deliberately NOT cleared — it's the record that iVol put them into Better Impact,
// and bi_correction_needed is how they're told to take them back out.
function unaccept(v, actor, note) {
  v.activity_log = v.activity_log || [];
  v.activity_log.push({ ts: new Date().toISOString(), actor, action: "reopen",
    from: v.call_outcome || null, via: "accepted_screen", ...(note ? { note } : {}) });
  if (v.ivol_entered) v.bi_correction_needed = true;
  v.call_done = false; v.call_outcome = null; v.ivol_ready = false;
  v.confirm_token = null; v.confirm_sent_at = null; v.confirmed_at = null;
}

// They hold no duty once they're no longer accepted. Clearing it (rather than leaving the row to be
// flagged stale_with_duty by the next session sync) is what lets the roster show the gap and the next
// duty allocation fill it — that engine is gap-fill only and will never reclaim a slot someone is
// still holding.
function clearDuties(v) {
  let cleared = 0;
  for (const r of (Array.isArray(v.event_assignments) ? v.event_assignments : [])) {
    if (!r) continue;
    if (String(r.duty || "").trim()) cleared++;
    r.duty = ""; r.state = "pending";
  }
  v.assigned_duty = null;
  return cleared;
}

const addDeclined = (v, area) => {
  if (!area) return;
  const prev = Array.isArray(v.declined_areas) ? v.declined_areas : [];
  v.declined_areas = [...new Set(prev.concat([area]))];
};

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = ((principal && principal.userDetails) || "").toLowerCase();
    const roles = (principal && principal.userRoles) || [];
    const ALLOWED = ["superadmin", "admin", "dutyteam", "quarterback", "leadership"];
    if (!email || !roles.some(r => ALLOWED.includes(r))) {
      context.res = { status: 403, body: { error: "Not authorized for this view." } }; return;
    }

    const seeAll = roles.includes("superadmin") || roles.includes("leadership");
    // Contact visibility deliberately mirrors api/volunteer's gate: the Duty Team can see who accepted,
    // but not their contact details. Emails are only put in this payload for roles that can already
    // see them one-by-one in the detail panel — the export must not widen who can read PII.
    const canSeeContact = roles.includes("superadmin") || roles.includes("admin")
      || roles.includes("leadership") || roles.includes("quarterback");
    let regionScope = null;   // admin/dutyteam: a Set of regions (all areas within)
    let qbScopes = [];        // quarterback: [{area, region}]
    if (!seeAll) {
      const store = await readRolesStore();
      if (roles.includes("admin") || roles.includes("dutyteam")) regionScope = new Set(allowedRegionsFor(store, email));
      if (roles.includes("quarterback")) qbScopes = scopesFor(store, email, "quarterback");
    }
    const inUserScope = (v) => {
      if (seeAll) return true;
      if (regionScope && regionScope.has(v.region)) return true;
      if (qbScopes.length && inScope(qbScopes, v.final_area, v.region)) return true;
      return false;
    };

    // Only read regions the viewer can touch.
    let regions;
    if (seeAll) regions = REGIONS;
    else { const rs = new Set(); if (regionScope) regionScope.forEach(r => rs.add(r)); qbScopes.forEach(s => rs.add(s.region)); regions = REGIONS.filter(r => rs.has(r)); }

    const container = await getContainer(DATA_CONTAINER);

    // ---- POST: undo an acceptance -----------------------------------------------------------------
    if (req.method === "POST") {
      // Deliberately narrower than the read gate: quarterbacks and leadership can SEE this screen but
      // may not un-accept, and the region wall for admin/dutyteam is the same one the list uses.
      if (!(roles.includes("superadmin") || roles.includes("admin") || roles.includes("dutyteam"))) {
        context.res = { status: 403, body: { error: "Duty Team, Admin, or Super Admin only." } }; return;
      }
      const body = req.body || {};
      const action = clean(body.action);
      const region = clean(body.region);
      const user_id = body.user_id;
      const referralArea = clean(body.referral_area);
      const note = clean(body.note);

      if (!ACTIONS.includes(action)) { context.res = { status: 400, body: { error: "Unknown action." } }; return; }
      if (!REGIONS.includes(region) || user_id == null) { context.res = { status: 400, body: { error: "Valid region and user_id required." } }; return; }
      // The write wall is computed independently of the read path's seeAll: leadership grants seeAll
      // and leaves regionScope null, so an admin who is ALSO leadership would otherwise be walled out
      // of every region rather than their own.
      if (!roles.includes("superadmin")) {
        const rs = regionScope || new Set(allowedRegionsFor(await readRolesStore(), email) || []);
        if (!rs.has(region)) { context.res = { status: 403, body: { error: "That region is outside your assigned events." } }; return; }
      }
      if (action === "decline_refer") {
        if (!referralArea) { context.res = { status: 400, body: { error: "Pick an area to refer them to." } }; return; }
        if (!AREAS.includes(referralArea)) { context.res = { status: 400, body: { error: "Unknown area." } }; return; }
      }

      const didars = await readDidars();
      let out = null;
      const result = await mutateVolunteer(container, region, user_id, (v) => {
        if (!isAcceptedVolunteer(v)) return { notAccepted: true };
        if (action === "decline_refer" && v.final_area === referralArea) return { sameArea: true };
        const from = v.final_area || null;
        const enteredInBi = !!v.ivol_entered;
        const dutiesCleared = clearDuties(v);
        unaccept(v, email, note);

        if (action === "withdraw") {
          // They're out. The area is moot — no point recording a decline against it, and no point
          // clearing it either: it's simply not read for anyone who isn't accepted.
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "outcome",
            outcome: "Withdrew", via: "accepted_screen", ...(note ? { note } : {}) });
          v.call_outcome = "Withdrew";
          v.call_done = true;
        } else if (action === "decline_refer") {
          // Mirrors api/calls' Declined-referred branch exactly, so a referral means the same thing
          // wherever it came from: fresh for the receiving area, whose QB reassigns a caller.
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: "outcome",
            outcome: "Declined-referred", via: "accepted_screen", ...(note ? { note } : {}) });
          addDeclined(v, from);                  // durable: they said no to THIS area
          v.referred_from = from;
          v.final_area = referralArea;
          v.assigned_caller = null;
          v.callable_status = "Stable";
          v.call_done = true;
          v.call_outcome = null;                 // fresh for the receiving area
          // The old area's rows carry that area's duty interests, which mean nothing in the new one —
          // and seedEventAssignments only ADDS rows, it never re-points an existing one. Reseed.
          v.event_assignments = seedEventAssignments({ ...v, event_assignments: [] }, didars);
        } else {
          // repool: they don't want the area they were given. Record the refusal BEFORE repool clears
          // final_area, or the fact is gone. unaccept() ran first, so the record is no longer
          // caller-locked and the shared repool applies cleanly.
          addDeclined(v, from);
          v.assigned_caller = null;
          repool(v, email);
        }
        out = { from, dutiesCleared, enteredInBi, declined: (v.declined_areas || []).slice() };
      });

      if (result.notFound) { context.res = { status: 404, body: { error: "Volunteer not found." } }; return; }
      if (result.extra && result.extra.notAccepted) { context.res = { status: 409, body: { error: "That volunteer isn't currently accepted — reload the screen." } }; return; }
      if (result.extra && result.extra.sameArea) { context.res = { status: 400, body: { error: "That's the area they're already in." } }; return; }
      if (!result.ok) { context.res = { status: 409, body: { error: "Couldn't save — please retry." } }; return; }

      const bits = [];
      if (out && out.dutiesCleared) bits.push(`Duty cleared (${out.dutiesCleared}) — the next duty allocation will refill the slot.`);
      if (out && out.enteredInBi) bits.push("They were already entered in Better Impact — flagged for the iVol team to remove.");
      if (action === "decline_refer") bits.push(`Referred to ${referralArea}; ${out && out.from ? out.from : "their old area"} recorded as declined.`);
      if (action === "repool") bits.push(`Back in the allocation pool; ${out && out.from ? out.from : "their old area"} recorded as declined, so the next allocation won't return them to it.`);
      context.res = { body: { ok: true, action, user_id, region, ...out, note: bits.join(" ") } };
      return;
    }

    const vols = [];
    for (const region of regions) {
      const { records } = await readRegion(container, region);
      for (const v of records) {
        if (!isAcceptedVolunteer(v)) continue;   // shared definition (excludes Leadership)
        if (!inUserScope(v)) continue;
        vols.push({
          id: v.user_id, name: ((v.first || "") + " " + (v.last || "")).trim() || "(no name)",
          region, jk: v.ceremony_jk || "", area: v.final_area || "", age: ageOf(v), iff: iffOf(v), diverse: diverseOf(v),
          entered: !!v.ivol_entered, acceptedAt: acceptedAt(v), duties: dutiesOf(v),
          assignedDuty: String(v.assigned_duty || "").trim(),   // the duty they were GIVEN (vs duties = interest)
          email: canSeeContact ? String(v.email || "").trim() : "",
        });
      }
    }
    vols.sort((a, b) => (a.region + a.name).localeCompare(b.region + b.name));
    context.res = { body: { volunteers: vols, count: vols.length, canEmail: canSeeContact } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
