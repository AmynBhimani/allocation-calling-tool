(function () {
  var AREAS = [
    "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
    "Seniors & Mobility", "Food Services", "Layout & Logistics", "Registration & Access",
    "Medical Services", "Finance & Procurement", "Environmental Sustainability",
    "Memorabilia & Design", "Jamati Preparation"
  ];
  var SPECIAL = ["Young Volunteers", "IFF", "Unassigned"];
  var REGIONS = ["BC", "Prairies", "Edmonton"];
  var EL = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
  var lastPlan = null;

  function banner(msg, kind) {
    var b = EL("banner"); if (!msg) { b.hidden = true; return; }
    b.hidden = false; b.className = "banner " + (kind || ""); b.textContent = msg;
  }
  function stripFromInputs() {
    var n = function (id) { return Math.max(0, parseInt(EL(id).value, 10) || 0); };
    return {
      BC: { "Food Services": n("bc_food"), "Reception & Hospitality": n("bc_rh") },
      Prairies: { "Reception & Hospitality": n("pr_rh"), "Food Services": n("pr_food") },
      Edmonton: { "Reception & Hospitality": n("ed_rh"), "Food Services": n("ed_food") }
    };
  }

  function matrixTable(d) {
    var present = AREAS.filter(function (a) {
      return REGIONS.some(function (R) { return (d.matrix[R] || {})[a]; });
    });
    var rowsHtml = "";
    function rowFor(area, cls) {
      var cells = "", tot = 0;
      REGIONS.forEach(function (R) { var v = (d.matrix[R] || {})[area] || 0; tot += v; cells += '<td class="n">' + (v || "") + "</td>"; });
      return '<tr class="' + (cls || "") + '"><td>' + esc(area) + "</td>" + cells + '<td class="n tcol">' + tot + "</td></tr>";
    }
    present.forEach(function (a) { rowsHtml += rowFor(a); });
    SPECIAL.forEach(function (a) { if (REGIONS.some(function (R) { return (d.matrix[R] || {})[a]; })) rowsHtml += rowFor(a, "special"); });
    // totals row
    var totCells = "", grand = 0;
    REGIONS.forEach(function (R) {
      var s = 0; Object.keys(d.matrix[R] || {}).forEach(function (k) { s += d.matrix[R][k]; });
      grand += s; totCells += '<td class="n">' + s + "</td>";
    });
    rowsHtml += '<tr class="tot"><td>Total</td>' + totCells + '<td class="n tcol">' + grand + "</td></tr>";
    return '<table class="matrix"><tr><th>Area</th><th>BC</th><th>Prairies</th><th>Edmonton</th><th>Total</th></tr>' + rowsHtml + "</table>";
  }

  function distTable(d) {
    var html = "";
    REGIONS.forEach(function (R) {
      var dr = d.distReport[R]; if (!dr) return;
      html += '<div class="sub2">' + R + " · distributing " + dr.poolOver16 + " unassigned over-16" + (dr.unplaced ? " · " + dr.unplaced + " couldn't be placed (age limits)" : "") + "</div>";
      html += '<table class="matrix"><tr><th>Area</th><th>Target %</th><th>Target</th><th>Placed</th></tr>';
      dr.targets.forEach(function (t) {
        html += "<tr><td>" + esc(t.area) + '</td><td class="n">' + Math.round(t.pct * 100) + '%</td><td class="n">' + t.target + '</td><td class="n tcol">' + t.placed + "</td></tr>";
      });
      html += "</table>";
    });
    return html;
  }

  function stripTable(d) {
    var html = '<table class="matrix"><tr><th>Region · Area</th><th>Requested</th><th>Available</th><th>Removed</th></tr>';
    REGIONS.forEach(function (R) {
      var sr = d.stripReport[R] || {};
      Object.keys(sr).forEach(function (A) {
        var s = sr[A];
        html += "<tr><td>" + R + " · " + esc(A) + '</td><td class="n">' + s.requested + '</td><td class="n">' + s.available + '</td><td class="n tcol">' + s.removed + (s.removed < s.requested ? " ⚠" : "") + "</td></tr>";
      });
    });
    return html + "</table>";
  }

  function render(d) {
    EL("empty").style.display = "none";
    var res = EL("res"); res.style.display = "block";
    var ageWarn = (d.withAge < d.total)
      ? '<div class="warn">Only ' + d.withAge + " of " + d.total + " records have an age on file, so " + d.nullAge + " people read as unknown age — they stay Unassigned and aren't placed into age-gated areas. Re-import with this build so the Age column is stored.</div>"
      : "";
    var html = ""
      + '<div class="kpis">'
      + '<div class="kpi"><div class="n">' + d.affinityTotal.toLocaleString() + '</div><div class="l">Affinity (final area kept) — expect ~1,068</div></div>'
      + '<div class="kpi"><div class="n">' + d.affinityLeaders.toLocaleString() + '</div><div class="l">of which leaders — expect ~267</div></div>'
      + '<div class="kpi"><div class="n">' + d.total.toLocaleString() + '</div><div class="l">total volunteers in workspace</div></div>'
      + (d.nullAge ? '<div class="kpi flag"><div class="n">' + d.nullAge.toLocaleString() + '</div><div class="l">unknown age (stay Unassigned)</div></div>' : "")
      + "</div>"
      + ageWarn
      + '<div class="sub2">Allocated by region &amp; area</div>' + matrixTable(d)
      + '<div class="sub2">Random removals into Unassigned</div>' + stripTable(d)
      + '<div class="sub2">Distribution of the Unassigned over-16 pool</div>' + distTable(d);
    if (d.mode === "commit") html += '<div class="ok">' + esc(d.note || "Committed.") + "</div>";
    res.innerHTML = html;
  }

  async function call(mode) {
    var seed = parseInt(EL("seed").value, 10) || 20260723;
    var body = { mode: mode, seed: seed, strip: stripFromInputs() };
    var btnP = EL("previewBtn"), btnC = EL("commitBtn");
    btnP.disabled = true; btnC.disabled = true;
    banner(mode === "commit" ? "Committing…" : "Calculating preview…", "");
    try {
      var r = await fetch("/api/allocate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      var d = await r.json();
      if (!r.ok) { banner(d.error || "Request failed.", "err"); btnP.disabled = false; return; }
      banner("", "");
      lastPlan = d; render(d);
      if (mode === "commit") { btnC.disabled = true; btnP.disabled = false; }
      else { btnP.disabled = false; btnC.disabled = false; }
    } catch (e) {
      banner(String(e && e.message || e), "err"); btnP.disabled = false;
    }
  }

  EL("previewBtn").addEventListener("click", function () { call("preview"); });
  EL("commitBtn").addEventListener("click", function () {
    if (!lastPlan) return;
    if (!confirm("Commit this allocation? Assigned people become Stable and callable; affinity assignments are left untouched. Run with the same seed so it matches your preview.")) return;
    call("commit");
  });
  // Re-running a preview is required before commit if settings change.
  ["bc_food", "bc_rh", "pr_rh", "pr_food", "ed_rh", "ed_food", "seed"].forEach(function (id) {
    EL(id).addEventListener("input", function () { EL("commitBtn").disabled = true; });
  });
})();
