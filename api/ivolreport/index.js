const { getContainer, readRegion, mutateVolunteer, REGIONS, readRolesStore, allowedRegionsFor,
        readConfigJson, readSessions } = require("../shared/store");
const { expandRoster, theSessionRow, STATE_SUBMITTED, STATE_ENTERED } = require("../dutyalloc/dutyalloc");

const CONN = process.env.RESPONSES_STORAGE;
const DATA_CONTAINER = process.env.DATA_CONTAINER || "tool-data";

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

const clean = (s) => String(s == null ? "" : s).trim();
const norm = (s) => clean(s).toLowerCase();

// One row per volunteer ready for Better Impact entry.
function acceptedAt(v) {
  let when = null;
  for (const e of (v.activity_log || [])) {
    if (e.action === "outcome" && e.outcome === "Accepted") when = e.ts;
  }
  return when;
}
function row(v, ctx) {
  // A volunteer's region fixes their Didar and their Jamatkhana fixes their session, so they have at
  // most ONE session row — which is what makes "their duty" unambiguous on a screen with no session
  // picker. sessionRow(v, id) needs an id; this is the same row found without one.
  const sr = theSessionRow(v);
  const duty = sr ? clean(sr.duty) : "";
  return {
    id: v.user_id, first: v.first, last: v.last, username: v.username || "",
    region: v.region, jk: v.ceremony_jk, committee: v.final_area,
    outcome: "Accepted", accepted_at: acceptedAt(v), entered: !!v.ivol_entered,
    // The duty side. Separate from `entered` on purpose: entering someone's registration into
    // Better Impact and entering their shift are two jobs, done at different times, and only the
    // second one locks.
    session: sr ? clean(sr.event) : "", sessionName: sr ? (ctx.names[clean(sr.event)] || clean(sr.event)) : "",
    area: sr ? clean(sr.area) : "", duty,
    dutyState: sr ? (clean(sr.state) || "pending") : "",
    checkIn: duty ? (ctx.checkIn[clean(sr.event) + "|" + clean(sr.area) + "|" + norm(duty)] || "") : "",
  };
}

module.exports = async function (context, req) {
  try {
    const principal = getPrincipal(req);
    const email = emailOf(principal);
    const roles = (principal && principal.userRoles) || [];
    const allowed = roles.includes("superadmin") || roles.includes("admin") || roles.includes("ivoladmin");
    if (!email || !allowed) { context.res = { status: 403, body: { error: "Admin or Super Admin only." } }; return; }
    if (!CONN) { context.res = { status: 500, body: { error: "Storage not configured." } }; return; }

    // Region wall: super-admins see all; admins are limited to their tagged events' regions.
    const isSuper = roles.includes("superadmin");
    const allowRegions = (isSuper || roles.includes("ivoladmin")) ? null : allowedRegionsFor(await readRolesStore(), email);
    const scopeRegions = allowRegions ? REGIONS.filter(r => allowRegions.includes(r)) : REGIONS;
    const container = await getContainer(DATA_CONTAINER);

    // Check-in times live on the roster, and a lead's is derived, so resolve them through the
    // engine's own expandRoster rather than reading the stored rows directly.
    const ctx = { checkIn: {}, names: {} };
    for (const s of (await readSessions(null)) || []) ctx.names[clean(s.id)] = clean(s.name);
    const rosterStore = (await readConfigJson("session-duties.json")) || {};
    for (const [sid, byArea] of Object.entries(rosterStore.sessions || {})) {
      for (const [area, rows] of Object.entries(byArea || {})) {
        for (const spec of expandRoster(rows || [])) ctx.checkIn[sid + "|" + area + "|" + norm(spec.duty)] = spec.checkIn;
      }
    }

    if (req.method === "GET") {
      const includeEntered = req.query.all === "1";
      const out = [];
      let pendingCount = 0, enteredCount = 0, dutyQueue = 0, dutyDone = 0;
      for (const region of scopeRegions) {
        const { records } = await readRegion(container, region);
        for (const v of records) {
          if (!v.ivol_ready) continue;
          if (!acceptedAt(v)) continue;                 // hide rows that were never actually Accepted
          if (v.ivol_entered) enteredCount++; else pendingCount++;
          const r = row(v, ctx);
          if (r.dutyState === STATE_SUBMITTED) dutyQueue++;
          if (r.dutyState === STATE_ENTERED) dutyDone++;
          // The default view hides people whose registration is already in Better Impact. Their DUTY
          // may still be waiting — that is the whole second pass — so a pending duty keeps the row
          // on screen. Without this the duty queue would be invisible by default.
          if (!includeEntered && v.ivol_entered && r.dutyState !== STATE_SUBMITTED) continue;
          out.push(r);
        }
      }
      out.sort((a, b) => (a.region.localeCompare(b.region)) || (a.committee || "").localeCompare(b.committee || "") || a.last.localeCompare(b.last));
      context.res = { body: { rows: out, count: out.length, pendingCount, enteredCount,
        total: pendingCount + enteredCount, dutyQueue, dutyDone } };
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const op = clean(body.op) || "contact";      // default keeps the original contract working
      const items = Array.isArray(body.items) ? body.items : [];   // [{user_id, region}]
      if (!items.length) { context.res = { status: 400, body: { error: "No volunteers given." } }; return; }

      // ---- the DUTY side: a separate job from the contact flag, and the only one that locks -----
      if (op === "duty_entered" || op === "duty_unenter") {
        const undo = op === "duty_unenter";
        // Undo asserts "this duty is NOT in Better Impact after all" — it un-freezes a row the area
        // has been told is settled. Super Admin only, and never a routine correction.
        if (undo && !isSuper) { context.res = { status: 403, body: { error: "Only a Super Admin can undo a duty entry." } }; return; }
        let done = 0, notSubmitted = 0, alreadyEntered = 0, noDuty = 0;
        for (const it of items) {
          if (!scopeRegions.includes(it.region)) continue;
          const result = await mutateVolunteer(container, it.region, it.user_id, (v) => {
            const sr = theSessionRow(v);
            if (!sr) return { skip: "noDuty" };
            const st = clean(sr.state);
            if (undo) {
              if (st !== STATE_ENTERED) return { skip: "notSubmitted" };
              sr.state = STATE_SUBMITTED;             // back into the queue, not back to the area
            } else {
              if (!clean(sr.duty)) return { skip: "noDuty" };
              if (st === STATE_ENTERED) return { skip: "alreadyEntered" };
              // Only a SUBMITTED duty may be entered. An allocated-but-unsubmitted one is still
              // being worked on by the area, and entering it would lock a lineup they hadn't finished.
              if (st !== STATE_SUBMITTED) return { skip: "notSubmitted" };
              sr.state = STATE_ENTERED;
            }
            v.activity_log = v.activity_log || [];
            v.activity_log.push({ ts: new Date().toISOString(), actor: email,
              action: undo ? "duty_unentered" : "duty_entered", session: clean(sr.event),
              area: clean(sr.area), duty: clean(sr.duty) });
          });
          const sk = (result.extra || {}).skip;
          if (sk === "noDuty") noDuty++;
          else if (sk === "notSubmitted") notSubmitted++;
          else if (sk === "alreadyEntered") alreadyEntered++;
          else if (result.ok) done++;
        }
        const bits = [undo ? `${done} duty entr(ies) undone \u2014 back in the queue.` : `${done} dut(ies) marked entered and locked.`];
        if (alreadyEntered) bits.push(`${alreadyEntered} were already entered.`);
        if (notSubmitted) bits.push(undo ? `${notSubmitted} weren't entered to begin with.`
          : `${notSubmitted} haven't been submitted by their area yet and were skipped.`);
        if (noDuty) bits.push(`${noDuty} have no duty yet.`);
        context.res = { body: { ok: true, updated: done, notSubmitted, alreadyEntered, noDuty, note: bits.join(" ") } };
        return;
      }

      // ---- the CONTACT side: unchanged, and still reversible ------------------------------------
      const entered = body.entered !== false;                      // default true
      let done = 0;
      for (const it of items) {
        if (!scopeRegions.includes(it.region)) continue;
        const result = await mutateVolunteer(container, it.region, it.user_id, (v) => {
          v.activity_log = v.activity_log || [];
          v.ivol_entered = entered;
          v.activity_log.push({ ts: new Date().toISOString(), actor: email, action: entered ? "ivol_entered" : "ivol_unentered" });
        });
        if (result.ok) done++;
      }
      context.res = { body: { ok: true, updated: done } };
      return;
    }

    context.res = { status: 405, body: { error: "Method not allowed" } };
  } catch (err) {
    context.res = { status: 500, body: { error: String(err && err.message || err) } };
  }
};
