(function () {
  var AREAS = [
    "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
    "Seniors & Mobility", "Food Services", "Layout & Logistics", "Registration & Access",
    "Medical Services", "Finance & Procurement", "Environmental Sustainability",
    "Memorabilia & Design", "Jamati Preparation"
  ];
  var SPECIAL = ["In reconciliation", "Young Volunteers", "IFF", "No age on file", "Unassigned"];
  var REGIONS = ["BC", "Prairies", "Edmonton"];
  var EL = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
  var lastPlan = null;

  // Editable allocation targets (percent of the over-16 Unassigned pool) with their age gates.
  var TARGET_DEFS = [
    { area: "Safety & Flow Management", id: "t_ssp", pct: 55, min: 19, max: null, rule: "min age 19" },
    { area: "Seniors & Mobility", id: "t_sen", pct: 14, min: 16, max: null, rule: "min age 16" },
    { area: "Reception & Hospitality", id: "t_rec", pct: 14, min: null, max: null, rule: "any age" },
    { area: "Environmental Sustainability", id: "t_env", pct: 2, min: 16, max: 20, rule: "age 16\u201320" },
    { area: "Parking & Transportation", id: "t_par", pct: 7, min: 19, max: 65, rule: "age 19\u201365" },
    { area: "Food Services", id: "t_food", pct: 4, min: 16, max: null, rule: "min age 16" },
    { area: "Layout & Logistics", id: "t_lay", pct: 4, min: 19, max: 65, rule: "age 19\u201365" }
  ];

  function buildTargetInputs() {
    var box = EL("targetCfg");
    box.innerHTML = TARGET_DEFS.map(function (t) {
      return '<div class="trow"><div><div class="nm">' + esc(t.area) + '</div><div class="ru">' + esc(t.rule) + '</div></div>'
        + '<div><input id="' + t.id + '" type="number" min="0" max="100" step="1" value="' + t.pct + '"><span class="pct">%</span></div></div>';
    }).join("");
    TARGET_DEFS.forEach(function (t) { EL(t.id).addEventListener("input", function () { onSettingChanged(); updatePctSum(); }); });
    updatePctSum();
  }
  function updatePctSum() {
    var sum = 0; TARGET_DEFS.forEach(function (t) { sum += (parseFloat(EL(t.id).value) || 0); });
    EL("pctSum").textContent = (Math.round(sum * 100) / 100);
    EL("pctWarn").textContent = (Math.abs(sum - 100) > 0.01) ? "— doesn't add up to 100%; the rest stays Unassigned (or, if over 100%, the pool runs out)" : "";
  }
  function targetsFromInputs() {
    return TARGET_DEFS.map(function (t) {
      return { area: t.area, pct: (parseFloat(EL(t.id).value) || 0) / 100, min: t.min, max: t.max };
    });
  }

  function onSettingChanged() { EL("commitBtn").disabled = true; }

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

  function listSection(title, key, rows, hint) {
    if (!rows || !rows.length) return "";
    var head = '<tr><th>Name</th><th>Region</th><th>Jamatkhana</th><th>Age</th></tr>';
    var body = rows.slice(0, 250).map(function (r) {
      return "<tr><td>" + esc(r.name || "—") + "</td><td>" + esc(r.region) + "</td><td>" + esc(r.jk || "—") + '</td><td class="n">' + (r.age == null ? "—" : r.age) + "</td></tr>";
    }).join("");
    var more = rows.length > 250 ? '<div class="small" style="margin-top:6px">Showing first 250 of ' + rows.length + ". Use Copy CSV for the full list.</div>" : "";
    return '<details class="lst"><summary>' + esc(title) + " (" + rows.length + ")</summary>"
      + (hint ? '<div class="small" style="margin:6px 0">' + esc(hint) + "</div>" : "")
      + '<button class="btn ghost2 csvbtn" data-csv="' + key + '">Copy CSV</button>'
      + '<table class="matrix">' + head + body + "</table>" + more + "</details>";
  }

  function render(d) {
    EL("empty").style.display = "none";
    var res = EL("res"); res.style.display = "block";
    var ageWarn = (d.withAge < d.total)
      ? '<div class="warn">' + d.nullAge + " of " + d.total + " volunteers have no age on file. They are held out of the allocation (not placed in any area) and flagged below so you can fix their birthdate/age in Better Impact and re-run.</div>"
      : "";
    var html = ""
      + '<div class="kpis">'
      + '<div class="kpi"><div class="n">' + d.affinityTotal.toLocaleString() + '</div><div class="l">Affinity (final area kept) — expect ~1,068</div></div>'
      + '<div class="kpi"><div class="n">' + d.affinityLeaders.toLocaleString() + '</div><div class="l">of which leaders — expect ~267</div></div>'
      + '<div class="kpi"><div class="n">' + (d.contestedTotal || 0).toLocaleString() + '</div><div class="l">In reconciliation (claimed, left alone)</div></div>'
      + (d.nullAge ? '<div class="kpi flag"><div class="n">' + d.nullAge.toLocaleString() + '</div><div class="l">no age on file (held &amp; flagged)</div></div>' : "")
      + "</div>"
      + ageWarn
      + '<div class="sub2">Allocated by region &amp; area</div>' + matrixTable(d)
      + '<div class="sub2">Random removals into Unassigned</div>' + stripTable(d)
      + '<div class="sub2">Distribution of the Unassigned over-16 pool</div>' + distTable(d);

    var L = d.lists || {};
    html += '<div class="sub2">Category lists</div>';
    html += listSection("In reconciliation — claimed in review, decision pending", "contested", L.contested, "These were assigned/claimed in the review tool and are NOT touched by the allocation.");
    html += listSection("IFF", "iff", L.iff, "Inter-faith family members — held in their own category, not assigned to a process area.");
    html += listSection("Young Volunteers (under 16)", "young", L.young, "Under 16 — held out of process areas (except those left in Reception & Hospitality).");
    html += listSection("No age on file", "noAge", L.noAge, "No age in the import — held out and flagged for follow-up.");
    html += listSection("Unassigned (16+, no area / not placed)", "unassigned", L.unassigned, "");

    if (d.mode === "commit") html += '<div class="ok">' + esc(d.note || "Committed.") + "</div>";
    res.innerHTML = html;

    res.querySelectorAll(".csvbtn").forEach(function (b) {
      b.addEventListener("click", function () {
        var rows = (lastPlan.lists || {})[b.getAttribute("data-csv")] || [];
        var csv = "Name,Region,Jamatkhana,Age\n" + rows.map(function (r) {
          return [r.name, r.region, r.jk, (r.age == null ? "" : r.age)].map(function (x) {
            x = String(x == null ? "" : x); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
          }).join(",");
        }).join("\n");
        navigator.clipboard.writeText(csv).then(function () { b.textContent = "Copied " + rows.length + " rows"; setTimeout(function () { b.textContent = "Copy CSV"; }, 1800); });
      });
    });
  }

  async function call(mode) {
    var seed = parseInt(EL("seed").value, 10) || 20260723;
    var body = { mode: mode, seed: seed, strip: stripFromInputs(), targets: targetsFromInputs() };
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
    EL(id).addEventListener("input", onSettingChanged);
  });
  buildTargetInputs();
})();
