(function () {
  var AREAS = [
    "Safety & Flow Management", "Parking & Transportation", "Reception & Hospitality",
    "Seniors & Mobility", "Food Services", "Layout & Logistics", "Registration & Access",
    "Medical Services", "Diverse Abilities Support", "Finance & Procurement", "Environmental Sustainability",
    "Memorabilia & Design", "Jamati Preparation"
  ];
  var SPECIAL = ["In reconciliation", "Young Volunteers", "IFF", "No age on file", "Unassigned"];
  var REGIONS = ["BC", "Prairies", "Edmonton"];
  var EL = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
  var lastPlan = null;

  // Editable target percentages — the goal share of the final mix per area, with age gates.
  var TARGET_DEFS = [
    { area: "Safety & Flow Management", id: "t_ssp", pct: 53, min: 19, max: null, rule: "min age 19" },
    { area: "Seniors & Mobility", id: "t_sen", pct: 14, min: 16, max: 55, rule: "age 16\u201355" },
    { area: "Reception & Hospitality", id: "t_rec", pct: 14, min: null, max: null, rule: "16+ (any list)" },
    { area: "Environmental Sustainability", id: "t_env", pct: 2, min: 13, max: 30, rule: "age 13\u201330 \u00b7 flex-only" },
    { area: "Parking & Transportation", id: "t_par", pct: 7, min: 19, max: 65, rule: "age 19\u201365" },
    { area: "Food Services", id: "t_food", pct: 4, min: 16, max: null, rule: "min age 16" },
    { area: "Layout & Logistics", id: "t_lay", pct: 4, min: 19, max: 65, rule: "age 19\u201365" },
    { area: "Memorabilia & Design", id: "t_mem", pct: 2, min: 16, max: null, rule: "min age 16 \u00b7 flex-only" },
    { area: "Registration & Access", id: "t_reg", pct: 0, min: 16, max: null, rule: "set target % & age" },
    { area: "Medical Services", id: "t_med", pct: 0, min: null, max: null, rule: "cert-driven · medical pros first (% is a goal only)" },
    { area: "Diverse Abilities Support", id: "t_da", pct: 0, min: null, max: null, rule: "set target % & age" }
  ];

  function buildTargetInputs() {
    var box = EL("targetCfg");
    box.innerHTML = TARGET_DEFS.map(function (t) {
      return '<div class="trow">'
        + '<div class="nm">' + esc(t.area) + (t.rule ? ' <span class="trule">' + esc(t.rule) + '</span>' : '') + '</div>'
        + '<div class="tctl">'
          + '<input id="' + t.id + '" type="number" min="0" max="100" step="1" value="' + t.pct + '"><span class="pct">%</span>'
          + '<span class="agelbl">age</span>'
          + '<input id="' + t.id + '_min" class="agein" type="number" min="0" max="120" step="1" placeholder="16" value="' + (t.min == null ? "" : t.min) + '" title="Minimum age. Blank = 16. Set below 16 to admit younger volunteers (e.g. 13).">'
          + '<span class="agedash">\u2013</span>'
          + '<input id="' + t.id + '_max" class="agein" type="number" min="0" max="120" step="1" placeholder="none" value="' + (t.max == null ? "" : t.max) + '" title="Maximum age. Blank = no upper limit.">'
        + '</div>'
      + '</div>';
    }).join("");
    TARGET_DEFS.forEach(function (t) {
      ["", "_min", "_max"].forEach(function (suf) {
        var el = EL(t.id + suf);
        if (el) el.addEventListener("input", function () { onSettingChanged(); updatePctSum(); });
      });
    });
    updatePctSum();
  }
  function updatePctSum() {
    var sum = 0; TARGET_DEFS.forEach(function (t) { sum += (parseFloat(EL(t.id).value) || 0); });
    EL("pctSum").textContent = (Math.round(sum * 100) / 100);
    EL("pctWarn").textContent = (Math.abs(sum - 100) > 0.01) ? "— doesn't add up to 100%; the rest stays Unassigned (or, if over 100%, the pool runs out)" : "";
  }
  function targetsFromInputs() {
    return TARGET_DEFS.map(function (t) {
      var minEl = EL(t.id + "_min"), maxEl = EL(t.id + "_max");
      var minV = minEl ? String(minEl.value).trim() : "";
      var maxV = maxEl ? String(maxEl.value).trim() : "";
      var minN = parseInt(minV, 10), maxN = parseInt(maxV, 10);
      return {
        area: t.area,
        pct: (parseFloat(EL(t.id).value) || 0) / 100,
        min: (minV === "" || isNaN(minN)) ? null : minN,
        max: (maxV === "" || isNaN(maxN)) ? null : maxN
      };
    });
  }

  function onSettingChanged() { EL("commitBtn").disabled = true; }

  function banner(msg, kind) {
    var b = EL("banner"); if (!msg) { b.hidden = true; return; }
    b.hidden = false; b.className = "banner " + (kind || ""); b.textContent = msg;
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
      html += '<div class="sub2">' + R + " · goal denominator " + dr.D + " (" + dr.reviewFixed + " review + " + dr.assignable + " assignable) · "
        + (dr.rounds || 4) + " rounds · " + (dr.flexTotal || 0) + " happy-anywhere"
        + (dr.unplaced ? " · " + dr.unplaced + " left Unassigned (picked only full areas)" : "") + "</div>";
      html += '<table class="matrix"><tr><th>Area</th><th>Goal</th><th>Filled</th><th>Over</th><th>Ceiling</th><th>Short by</th></tr>';
      dr.targets.forEach(function (t) {
        var ceil = (t.ceiling == null ? "" : t.ceiling);
        var shortTxt = t.shortBy ? '<b style="color:#a83729">' + t.shortBy + "</b>" : "—";
        var overTxt = t.over ? '<b style="color:#b26a00">+' + t.over + "</b>" : "—";
        // Ceiling note: when the honest max is below the goal, the goal simply can't be reached without
        // more volunteers willing to do that area — flag it so the shortfall reads as recruiting signal.
        var capFlag = (t.ceiling != null && t.ceiling < t.target) ? ' title="Not enough willing volunteers to reach goal" style="color:#a83729"' : "";
        html += "<tr><td>" + esc(t.area) + '</td><td class="n">' + t.target
          + '</td><td class="n tcol">' + t.final
          + '</td><td class="n">' + overTxt
          + '</td><td class="n"' + capFlag + ">" + ceil
          + '</td><td class="n">' + shortTxt + "</td></tr>";
      });
      html += "</table>";
    });
    return html;
  }


  function placeLabel(r) {
    if (r.bucket === "affinity" || r.bucket === "assigned") return r.area || "—";
    if (r.bucket === "contested") return "In reconciliation";
    if (r.bucket === "iff") return "IFF";
    if (r.bucket === "noage") return "No age — held out";
    if (r.bucket === "young") return "Young Volunteers";
    return "Unassigned";
  }
  function listSection(title, key, rows, hint, showPlace, showReason) {
    if (!rows || !rows.length) return "";
    var head = '<tr><th>Name</th><th>Region</th><th>Jamatkhana</th><th>Age</th>' + (showPlace ? "<th>Where they landed</th>" : "") + (showReason ? "<th>Why unassigned</th>" : "") + "</tr>";
    var body = rows.slice(0, 250).map(function (r) {
      return "<tr><td>" + esc(r.name || "—") + "</td><td>" + esc(r.region) + "</td><td>" + esc(r.jk || "—") + '</td><td class="n">' + (r.age == null ? "—" : r.age) + "</td>"
        + (showPlace ? "<td>" + esc(placeLabel(r)) + "</td>" : "")
        + (showReason ? "<td>" + esc(r.reason || "—") + "</td>" : "") + "</tr>";
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
    var held = d.noAgeHeld || 0, placed = (d.nullAge || 0) - held;
    var ageWarn = d.nullAge
      ? '<div class="warn"><b>' + d.nullAge.toLocaleString() + "</b> volunteers have no age on file. <b>" + held.toLocaleString()
        + "</b> of them are held out of the allocation (no age and not from the review) — that's the \u201cNo age on file\u201d row in the table. The other <b>" + placed.toLocaleString()
        + "</b> were already assigned or claimed in the review tool (or are IFF), so they keep their place and are only flagged here. Everyone missing an age is in the \u201cNo age on file (all)\u201d list with where each landed. No one is counted twice.</div>"
      : "";
    var html = ""
      + '<div class="kpis">'
      + '<div class="kpi"><div class="n">' + d.affinityTotal.toLocaleString() + '</div><div class="l">Affinity — review-assigned, kept as-is</div></div>'
      + '<div class="kpi"><div class="n">' + d.affinityLeaders.toLocaleString() + '</div><div class="l">of which leaders — expect ~267</div></div>'
      + '<div class="kpi"><div class="n">' + (d.contestedTotal || 0).toLocaleString() + '</div><div class="l">In reconciliation (claimed, left alone)</div></div>'
      + (d.nullAge ? '<div class="kpi flag"><div class="n">' + d.nullAge.toLocaleString() + '</div><div class="l">missing an age (' + (d.noAgeHeld || 0).toLocaleString() + ' held · rest already placed)</div></div>' : "")
      + (d.youngFamilyPlaced ? '<div class="kpi"><div class="n">' + d.youngFamilyPlaced.toLocaleString() + '</div><div class="l">young (5–13) placed with family by email</div></div>' : "")
      + (d.medicalPlaced ? '<div class="kpi"><div class="n">' + d.medicalPlaced.toLocaleString() + '</div><div class="l">medical professionals placed in Medical Services</div></div>' : "")
      + "</div>";

    var a = d.audit || {};
    html += '<div class="sub2">Data check</div>';
    html += '<div class="' + (a.duplicateRows ? "warn" : "ok") + '">Read <b>' + (a.rawRecords || 0).toLocaleString() + "</b> rows from the workspace → <b>"
      + (a.unique || 0).toLocaleString() + "</b> unique people allocated"
      + (a.writeIns ? " (includes " + a.writeIns.toLocaleString() + " written-in / No-BI people added during the review)" : "")
      + (a.duplicateRows
        ? '. ⚠ <b>' + a.duplicateRows.toLocaleString() + "</b> duplicate row(s) covering <b>" + a.duplicateIds.toLocaleString()
          + "</b> people were found — the same person sitting in more than one region shard. They're counted once here, but the extra copies should be cleaned up so a re-import doesn't keep them."
        : " — every person counted exactly once.")
      + "</div>";
    if (a.duplicates && a.duplicates.length) {
      html += '<details class="lst"><summary>Duplicated people (' + a.duplicates.length + (a.duplicateIds > a.duplicates.length ? " of " + a.duplicateIds : "") + ")</summary>"
        + '<button class="btn ghost2 dupcsv">Copy CSV</button>'
        + '<table class="matrix"><tr><th>User ID</th><th>Appears in regions</th></tr>'
        + a.duplicates.slice(0, 250).map(function (x) { return "<tr><td>" + esc(x.user_id) + "</td><td>" + esc((x.regions || []).join(", ")) + "</td></tr>"; }).join("")
        + "</table></details>";
    }

    html += ageWarn
      + '<div class="sub2">Allocated by region &amp; area</div>' + matrixTable(d)
      + '<div class="sub2">Distribution toward the target percentages</div>' + distTable(d);

    var L = d.lists || {};
    html += '<div class="sub2">Category lists</div>';
    html += listSection("In reconciliation — claimed in review, decision pending", "contested", L.contested, "These were assigned/claimed in the review tool and are NOT touched by the allocation.");
    html += listSection("IFF", "iff", L.iff, "Inter-faith family members — held in their own category, not assigned to a process area.");
    html += listSection("Young Volunteers (under 16)", "young", L.young, "Under 16 — held aside, not allocated.");
    html += listSection("No age on file (all) — everyone missing an age, and where each landed", "noAge", L.noAge, "The held subset (no area) plus people already assigned/claimed in review who also lack an age.", true);
    html += listSection("Unassigned (16+, no area / not placed)", "unassigned", L.unassigned, "Each person's reason shows why they weren't placed — e.g. they picked no area, or their age is outside the range of every area they picked (removing another area's age cap won't help unless they picked it or chose 'happy anywhere').", false, true);

    if (d.mode === "commit") html += '<div class="ok">' + esc(d.note || "Committed.") + "</div>";
    res.innerHTML = html;

    res.querySelectorAll(".csvbtn").forEach(function (b) {
      b.addEventListener("click", function () {
        var rows = (lastPlan.lists || {})[b.getAttribute("data-csv")] || [];
        var csv = "Name,Region,Jamatkhana,Age,Where they landed,Why unassigned\n" + rows.map(function (r) {
          return [r.name, r.region, r.jk, (r.age == null ? "" : r.age), placeLabel(r), r.reason || ""].map(function (x) {
            x = String(x == null ? "" : x); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
          }).join(",");
        }).join("\n");
        navigator.clipboard.writeText(csv).then(function () { b.textContent = "Copied " + rows.length + " rows"; setTimeout(function () { b.textContent = "Copy CSV"; }, 1800); });
      });
    });
    var db = res.querySelector(".dupcsv");
    if (db) db.addEventListener("click", function () {
      var rows = ((lastPlan.audit || {}).duplicates) || [];
      var csv = "UserID,Regions\n" + rows.map(function (r) { return r.user_id + ',"' + (r.regions || []).join(", ") + '"'; }).join("\n");
      navigator.clipboard.writeText(csv).then(function () { db.textContent = "Copied " + rows.length + " rows"; setTimeout(function () { db.textContent = "Copy CSV"; }, 1800); });
    });
  }

  // ---- Persist last-used settings (targets + toggles) across sessions ----
  function currentSettings() {
    var t = {};
    TARGET_DEFS.forEach(function (def) {
      t[def.area] = { pct: EL(def.id) ? EL(def.id).value : "", min: EL(def.id + "_min") ? EL(def.id + "_min").value : "", max: EL(def.id + "_max") ? EL(def.id + "_max").value : "" };
    });
    return {
      seed: EL("seed") ? EL("seed").value : "", rounds: EL("rounds") ? EL("rounds").value : "",
      overflow: EL("overflow") ? EL("overflow").checked : true,
      youngFamily: EL("youngFamily") ? EL("youngFamily").checked : true,
      medicalFirst: EL("medicalFirst") ? EL("medicalFirst").checked : true,
      phaseOrder: EL("phaseOrder") ? EL("phaseOrder").value : "",
      flexOrder: EL("flexOrder") ? EL("flexOrder").value : "",
      allocMode: EL("allocMode") ? EL("allocMode").value : "",
      targets: t,
    };
  }
  function applySettings(s) {
    if (!s) return;
    if (EL("seed") && s.seed != null && s.seed !== "") EL("seed").value = s.seed;
    if (EL("rounds") && s.rounds != null && s.rounds !== "") EL("rounds").value = s.rounds;
    if (EL("overflow") && typeof s.overflow === "boolean") EL("overflow").checked = s.overflow;
    if (EL("youngFamily") && typeof s.youngFamily === "boolean") EL("youngFamily").checked = s.youngFamily;
    if (EL("medicalFirst") && typeof s.medicalFirst === "boolean") EL("medicalFirst").checked = s.medicalFirst;
    if (EL("phaseOrder") && s.phaseOrder) EL("phaseOrder").value = s.phaseOrder;
    if (EL("flexOrder") && s.flexOrder) EL("flexOrder").value = s.flexOrder;
    if (EL("allocMode") && s.allocMode) EL("allocMode").value = s.allocMode;
    if (s.targets) TARGET_DEFS.forEach(function (def) {
      var v = s.targets[def.area]; if (!v) return;   // new/renamed areas keep their default
      if (EL(def.id) && v.pct != null && v.pct !== "") EL(def.id).value = v.pct;
      if (EL(def.id + "_min")) EL(def.id + "_min").value = (v.min == null ? "" : v.min);
      if (EL(def.id + "_max")) EL(def.id + "_max").value = (v.max == null ? "" : v.max);
    });
    updatePctSum();
  }
  function currentEvent() { return EL("allocEvent") ? EL("allocEvent").value : ""; }
  function saveSettings() {
    try { fetch("/api/allocsettings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: currentSettings(), event: currentEvent() }) }); } catch (e) {}
  }
  async function restoreSettings() {
    try {
      var ev = currentEvent();
      var r = await fetch("/api/allocsettings" + (ev ? "?event=" + encodeURIComponent(ev) : "")); if (!r.ok) return;
      var d = await r.json(); if (d && d.settings) applySettings(d.settings);
    } catch (e) {}
  }
  // Load the Didars into the event picker; selecting one scopes the allocation to its regions and
  // loads that event’s saved targets. Default stays "All regions" so nothing changes unless chosen.
  async function loadEvents() {
    try {
      var r = await fetch("/api/events"); if (!r.ok) return;
      var d = await r.json(); var didars = ((d && d.events) || []).filter(function (e) { return !e.parent && e.active !== false; });
      var sel = EL("allocEvent"); if (!sel) return;
      var regById = {};
      didars.forEach(function (e) {
        regById[e.id] = (e.regions || []).join(", ");
        var o = document.createElement("option"); o.value = e.id; o.textContent = e.name; sel.appendChild(o);
      });
      function showRegions() { var lab = EL("allocEventRegions"); if (lab) lab.textContent = sel.value ? ("· " + (regById[sel.value] || "no regions yet")) : "· all regions"; }
      sel.addEventListener("change", function () { showRegions(); restoreSettings(); onSettingChanged(); });
      showRegions();
    } catch (e) {}
  }

  async function call(mode) {
    var seed = parseInt(EL("seed").value, 10) || 20260723;
    var rounds = Math.max(1, Math.min(20, parseInt(EL("rounds").value, 10) || 4));
    var overflow = EL("overflow") ? !!EL("overflow").checked : true;
    var happyFirst = EL("phaseOrder") ? (EL("phaseOrder").value === "happy") : false;
    var flexOrder = EL("flexOrder") ? EL("flexOrder").value : "below";
    var allocMode = EL("allocMode") ? EL("allocMode").value : "full";
    var youngFamily = EL("youngFamily") ? !!EL("youngFamily").checked : true;
    var medicalFirst = EL("medicalFirst") ? !!EL("medicalFirst").checked : true;
    var body = { mode: mode, allocMode: allocMode, seed: seed, rounds: rounds, overflow: overflow, happyFirst: happyFirst, flexOrder: flexOrder, youngFamilyMatch: youngFamily, medicalFirst: medicalFirst, event: currentEvent(), targets: targetsFromInputs() };
    var btnP = EL("previewBtn"), btnC = EL("commitBtn");
    btnP.disabled = true; btnC.disabled = true;
    banner(mode === "commit" ? "Committing…" : "Calculating preview…", "");
    try {
      var r = await fetch("/api/allocate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      var d = await r.json();
      if (!r.ok) { banner(d.error || "Request failed.", "err"); btnP.disabled = false; return; }
      banner("", "");
      lastPlan = d; render(d);
      saveSettings();   // remember what was used, for next time
      if (mode === "commit") { btnC.disabled = true; btnP.disabled = false; }
      else { btnP.disabled = false; btnC.disabled = false; }
    } catch (e) {
      banner(String(e && e.message || e), "err"); btnP.disabled = false;
    }
  }

  EL("previewBtn").addEventListener("click", function () { call("preview"); });
  EL("commitBtn").addEventListener("click", function () {
    if (!lastPlan) return;
    var m = EL("allocMode") ? EL("allocMode").value : "full";
    var msg = (m === "incremental")
      ? "Commit this INCREMENTAL allocation? Everyone who already has an area stays put; only the unassigned pool is placed. Run with the same seed so it matches your preview."
      : "Commit this FULL allocation? Assigned people become Stable and callable. Left untouched: review (affinity) assignments, anyone called/accepted, and anyone on a caller's list. Run with the same seed so it matches your preview.";
    if (!confirm(msg)) return;
    call("commit");
  });
  // Re-running a preview is required before commit if settings change.
  EL("seed").addEventListener("input", onSettingChanged);
  ["allocMode", "rounds", "phaseOrder", "flexOrder", "overflow", "youngFamily", "medicalFirst"].forEach(function (id) {
    var el = EL(id); if (el) el.addEventListener("change", onSettingChanged);
  });
  buildTargetInputs();
  (async function () { await loadEvents(); await restoreSettings(); })();   // populate events, then that event’s settings
})();
