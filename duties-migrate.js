// Recategorise duties between areas. Pick the source area, the duties to pull out of it, and the
// target; Preview shows exactly what moves and who; Commit applies it. Nothing is written until
// Commit, and Commit only arms after a clean Preview — you never move people sight unseen.
(function () {
  var DUTIES_BY_AREA = {}, AREAS = [], PLAN = null, picked = {};
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(m, e) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (e ? " err" : ""); b.innerHTML = m; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }
  function from() { return EL("fromArea").value || ""; }
  function to() { return EL("toArea").value || ""; }

  function load() {
    return fetch("/api/migrateduties").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { banner(esc(d.error), true); return; }
      AREAS = d.areas || [];
      DUTIES_BY_AREA = d.dutiesByArea || {};
      var opts = function (sel) {
        return '<option value="">\u2014 choose \u2014</option>'
          + AREAS.map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + "</option>"; }).join("");
      };
      EL("fromArea").innerHTML = opts();
      EL("toArea").innerHTML = opts();
    }).catch(function () { banner("Couldn\u2019t load areas.", true); });
  }

  function renderPicker() {
    picked = {};
    PLAN = null; EL("out").innerHTML = ""; EL("commitBtn").disabled = true;
    var list = (DUTIES_BY_AREA[from()] || []);
    if (!from()) { EL("dutyPick").innerHTML = ""; EL("previewBtn").disabled = true; return; }
    if (!list.length) {
      EL("dutyPick").innerHTML = '<span style="color:#9b5b50">' + esc(from()) + " has no duties to move.</span>";
      EL("previewBtn").disabled = true; return;
    }
    EL("dutyPick").innerHTML = "<div style=\"margin-bottom:6px\">Duties to move:</div>"
      + '<label class="toggle" style="margin-bottom:8px"><input type="checkbox" id="pickAll"> Select all ' + num(list.length) + "</label>"
      + '<div class="pickgrid">' + list.map(function (d) {
          return '<label class="toggle"><input type="checkbox" class="dutychk" value="' + esc(d) + '"> ' + esc(d) + "</label>";
        }).join("") + "</div>";
    Array.prototype.forEach.call(document.querySelectorAll(".dutychk"), function (cb) {
      cb.addEventListener("change", function () { picked[cb.value] = cb.checked; refreshPreviewBtn(); });
    });
    EL("pickAll").addEventListener("change", function (e) {
      Array.prototype.forEach.call(document.querySelectorAll(".dutychk"), function (cb) {
        cb.checked = e.target.checked; picked[cb.value] = cb.checked;
      });
      refreshPreviewBtn();
    });
    refreshPreviewBtn();
  }
  function chosenDuties() { return Object.keys(picked).filter(function (k) { return picked[k]; }); }
  function refreshPreviewBtn() {
    EL("previewBtn").disabled = !(from() && to() && from() !== to() && chosenDuties().length);
    PLAN = null; EL("commitBtn").disabled = true;
    if (from() && to() && from() === to()) banner("Source and target can\u2019t be the same area.", true); else clearBanner();
  }

  function post(commit) {
    return fetch("/api/migrateduties", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: from(), to: to(), duties: chosenDuties(), commit: commit }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
  }

  function preview() {
    clearBanner();
    EL("out").innerHTML = '<div class="card"><div class="small">Working\u2026</div></div>';
    post(false).then(function (res) {
      if (!res.ok) { EL("out").innerHTML = ""; banner(esc(res.d.error || "Failed."), true); return; }
      PLAN = res.d.plan;
      render(res.d.plan);
      // Arm Commit only when there is actually something to do.
      EL("commitBtn").disabled = !(PLAN.counts.dutiesMoving || PLAN.counts.peopleMoving);
    }).catch(function (e) { EL("out").innerHTML = ""; banner("Failed: " + esc(e.message), true); });
  }

  function render(plan) {
    var c = plan.counts, html = "";
    html += '<div class="card"><div class="kpis">'
      + '<div class="kpi"><div class="n">' + num(c.dutiesMoving) + '</div><div class="l">duties moving</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.peopleMoving) + '</div><div class="l">people moving</div></div>'
      + (c.leftBehind ? '<div class="kpi"><div class="n">' + num(c.leftBehind) + '</div><div class="l">left in ' + esc(plan.from) + "</div></div>" : "")
      + (c.dutiesBlocked ? '<div class="kpi flag"><div class="n">' + num(c.dutiesBlocked) + '</div><div class="l">blocked</div></div>' : "")
      + (c.stranded ? '<div class="kpi flag"><div class="n">' + num(c.stranded) + '</div><div class="l">stranded</div></div>' : "")
      + (c.biCorrections ? '<div class="kpi"><div class="n">' + num(c.biCorrections) + '</div><div class="l">BI fixes</div></div>' : "")
      + "</div>";

    if (c.dutiesBlocked) {
      html += '<div class="warn"><b>These duties can\u2019t move:</b><ul style="margin:6px 0 0 18px">'
        + plan.duties.blocked.map(function (b) {
            var who = b.holders ? " (" + b.holders.map(function (h) { return esc(h.name); }).join(", ") + ")" : "";
            return "<li>" + esc(b.duty) + " \u2014 " + esc(b.detail) + who + "</li>";
          }).join("") + "</ul></div>";
    }
    if (c.stranded) {
      html += '<div class="warn"><b>' + num(c.stranded) + " volunteer(s) can\u2019t move</b> because the duty tying them "
        + "to this migration is blocked above. Clear the block, then re-run.</div>";
    }
    html += "</div>";

    // What moves
    html += '<div class="sub2">Duties moving to ' + esc(plan.to) + "</div>";
    if (plan.duties.willMove.length) {
      html += '<div class="scrollx"><table class="matrix"><tr><th>Duty</th><th class="n">Roster rows</th></tr>'
        + plan.duties.willMove.map(function (d) {
            var rows = plan.rosterMoves.filter(function (r) { return r.duty === d; });
            return "<tr><td>" + esc(d) + '</td><td class="n">' + (rows.length
              ? rows.map(function (r) { return esc(r.sessionName); }).join(", ") : "\u2014") + "</td></tr>";
          }).join("") + "</table></div>";
    } else html += '<div class="small">None \u2014 every selected duty is blocked.</div>';

    // Who moves
    if (plan.people.move.length) {
      html += '<div class="sub2">People moving</div><div class="scrollx">'
        + '<table class="matrix"><tr><th>Name</th><th>Region</th><th>Keeps duty</th><th>Better Impact</th></tr>'
        + plan.people.move.map(function (m) {
            return "<tr><td>" + esc(m.name) + "</td><td>" + esc(m.region) + "</td><td>"
              + (m.keepsDuty ? esc(m.duty) : '<span class="small">no duty \u2014 will be allocated in ' + esc(plan.to) + "</span>")
              + "</td><td>" + (m.biCorrection ? '<span style="color:#9b5b50">committee needs fixing</span>' : '<span class="small">\u2014</span>')
              + "</td></tr>";
          }).join("") + "</table></div>";
    }

    // Who stays
    if (plan.people.leftBehind.length) {
      html += '<div class="sub2">Left in ' + esc(plan.from) + " (interested, but committed to a duty that isn\u2019t moving)</div>"
        + '<div class="scrollx"><table class="matrix"><tr><th>Name</th><th>Region</th><th>On duty</th></tr>'
        + plan.people.leftBehind.map(function (m) {
            return "<tr><td>" + esc(m.name) + "</td><td>" + esc(m.region) + "</td><td>" + esc(m.heldDuty) + "</td></tr>";
          }).join("") + "</table></div>";
    }

    EL("out").innerHTML = html;
  }

  function commit() {
    if (!PLAN) return;
    var c = PLAN.counts;
    var msg = "Move " + num(c.dutiesMoving) + " duty(ies) and " + num(c.peopleMoving)
      + " volunteer(s) from " + from() + " to " + to() + "?";
    if (c.leftBehind) msg += "\n\n" + num(c.leftBehind) + " interested volunteer(s) will be LEFT in " + from()
      + " because they're on a duty that isn't moving.";
    if (c.dutiesBlocked) msg += "\n\n" + num(c.dutiesBlocked) + " duty(ies) are blocked and will NOT move.";
    msg += "\n\nNobody is un-accepted. This rewrites the catalogue, the rosters, and these people's area.";
    if (!confirm(msg)) return;
    clearBanner();
    EL("commitBtn").disabled = true;
    post(true).then(function (res) {
      if (!res.ok) { banner(esc(res.d.error || "Failed."), true); return; }
      banner(esc(res.d.note), !!(res.d.moveSkipped || (res.d.blocked && res.d.blocked.length)));
      // Reload the picker: the moved duties are now in the target area, not the source.
      load().then(function () { renderPicker(); });
    }).catch(function (e) { banner("Failed: " + esc(e.message), true); EL("commitBtn").disabled = false; });
  }

  EL("fromArea").addEventListener("change", renderPicker);
  EL("toArea").addEventListener("change", refreshPreviewBtn);
  EL("previewBtn").addEventListener("click", preview);
  EL("commitBtn").addEventListener("click", commit);
  load();
})();
