// Duty review — an area's lineup for one session: who is on what, what is short, and who leads.
//
// Reassigning saves IMMEDIATELY, one person at a time. No bulk apply, deliberately: a lineup gets
// picked over a few people at a time by someone on a phone between other things, and a half-filled
// form that loses its changes on a stray reload is worse than a save per row.
(function () {
  var SESSIONS = [], VIEW = null;
  // Same filter model as the iVol Input Report, so the two screens behave identically: filtering is
  // client-side over the loaded lineup, and the JK list narrows to the chosen region.
  var filters = { q: "", region: "", jk: "", duty: "", state: "", mine: false };
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }
  function session() { return EL("event").value || ""; }
  function area() { return EL("area").value || ""; }

  function fillAreas() {
    var s = SESSIONS.filter(function (x) { return x.id === session(); })[0];
    var areas = (s && s.areas) || [];
    var keep = area();
    EL("area").innerHTML = areas.length
      ? areas.map(function (a) {
          return '<option value="' + esc(a) + '"' + (a === keep ? " selected" : "") + ">" + esc(a) + "</option>";
        }).join("")
      : '<option value="">(no areas you can review)</option>';
    EL("area").disabled = !areas.length;
    EL("loadBtn").disabled = !areas.length;
    EL("scope").textContent = areas.length ? "" : "No area in this session has a duty roster you can review.";
  }

  function load() {
    return fetch("/api/dutyreview").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { banner(esc(d.error), true); return; }
      SESSIONS = (d && d.sessions) || [];
      EL("event").innerHTML = SESSIONS.length
        ? SESSIONS.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>"; }).join("")
        : '<option value="">(no sessions)</option>';
      fillAreas();
    }).catch(function () { banner("Couldn\u2019t load sessions.", true); });
  }

  function show() {
    clearBanner();
    if (!session() || !area()) return;
    EL("out").innerHTML = '<div class="card"><div class="small">Loading\u2026</div></div>';
    fetch("/api/dutyreview?session=" + encodeURIComponent(session()) + "&area=" + encodeURIComponent(area()))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { EL("out").innerHTML = ""; banner(esc(d.error), true); EL("submitBtn").disabled = true; return; }
        VIEW = d;
        EL("filters").hidden = false;
        EL("fMine").parentNode.hidden = !d.partial;   // pointless when you can change everyone
        buildFilterOptions(d);
        render(d);
        EL("submitBtn").disabled = !d.counts.allocated;
      })
      .catch(function (e) { EL("out").innerHTML = ""; banner("Failed: " + esc(e.message), true); });
  }

  // One person's duty dropdown. Locked rows and rows outside your regions render as plain text —
  // a disabled control the reader can't explain is worse than no control.
  function dutyCell(p, duties) {
    if (p.locked) {
      return esc(p.duty) + ' <span class="small">\u2014 in iVolunteer, locked</span>';
    }
    if (!p.canEdit) {
      return (p.duty ? esc(p.duty) : '<span style="color:#9b5b50">none yet</span>')
        + ' <span class="small">\u2014 ' + esc(p.region) + "</span>";
    }
    return '<select class="dutysel" data-id="' + esc(p.user_id) + '" data-region="' + esc(p.region) + '">'
      + '<option value="">(no duty)</option>'
      + duties.map(function (x) {
          var gate = x.minAge ? " \u2014 " + x.minAge + "+" : "";
          return '<option value="' + esc(x.duty) + '"' + (x.duty === p.duty ? " selected" : "") + ">"
            + esc(x.duty) + gate + "</option>";
        }).join("")
      + "</select>";
  }

  // "(no duty)" has to be selectable, not just a blank option — finding who still needs placing is
  // the single most common reason to filter this screen.
  var NODUTY = "\u2014 none \u2014";
  function setOpts(id, allLabel, items, cur) {
    EL(id).innerHTML = '<option value="">' + allLabel + "</option>"
      + items.map(function (x) { return '<option value="' + esc(x) + '"' + (x === cur ? " selected" : "") + ">" + esc(x) + "</option>"; }).join("");
  }
  function buildFilterOptions(d) {
    var regions = [];
    (d.people || []).forEach(function (p) { if (regions.indexOf(p.region) < 0) regions.push(p.region); });
    var jkPool = (d.people || []).filter(function (p) { return !filters.region || p.region === filters.region; });
    var jks = [];
    jkPool.forEach(function (p) { if (p.jk && jks.indexOf(p.jk) < 0) jks.push(p.jk); });
    var duties = (d.duties || []).map(function (x) { return x.duty; });
    if ((d.people || []).some(function (p) { return !p.duty; })) duties = [NODUTY].concat(duties);
    setOpts("fRegion", "All regions", regions.sort(), filters.region);
    setOpts("fJk", "All Jamatkhanas", jks.sort(), filters.jk);
    setOpts("fDuty", "All duties", duties, filters.duty);
    setOpts("fState", "All states", ["pending", "allocated", "submitted", "entered"], filters.state);
    // A region filter is noise on a single-region session, but the cross-region ones need it badly.
    EL("fRegion").hidden = (d.regions || []).length < 2;
  }
  function matches(p) {
    if (filters.q && p.name.toLowerCase().indexOf(filters.q) < 0) return false;
    if (filters.region && p.region !== filters.region) return false;
    if (filters.jk && p.jk !== filters.jk) return false;
    if (filters.duty === NODUTY) { if (p.duty) return false; }
    else if (filters.duty && p.duty !== filters.duty) return false;
    if (filters.state && (p.locked ? "entered" : p.state === "submitted" ? "submitted" : p.duty ? "allocated" : "pending") !== filters.state) return false;
    if (filters.mine && (!p.canEdit || p.locked)) return false;
    return true;
  }

  function stateChip(p) {
    if (p.locked) return '<span class="small" style="color:#1E6C57">entered</span>';
    if (p.state === "submitted") return '<span class="small">submitted</span>';
    if (p.duty) return '<span class="small">allocated</span>';
    return '<span class="small" style="color:#9b5b50">pending</span>';
  }

  function render(d) {
    var c = d.counts, html = "";

    html += '<div class="card">';
    html += '<div class="kpis">'
      + '<div class="kpi"><div class="n">' + num(c.members) + '</div><div class="l">in this lineup</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.allocated) + '</div><div class="l">allocated</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.submitted) + '</div><div class="l">submitted to iVol</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.entered) + '</div><div class="l">entered &amp; locked</div></div>'
      + (c.pending ? '<div class="kpi flag"><div class="n">' + num(c.pending) + '</div><div class="l">no duty yet</div></div>' : "")
      + (c.shortfallTotal ? '<div class="kpi flag"><div class="n">' + num(c.shortfallTotal) + '</div><div class="l">places to fill</div></div>' : "")
      + '<div class="kpi' + (c.leadsChosen < c.leadsRequired ? " flag" : "") + '"><div class="n">'
      + num(c.leadsChosen) + " / " + num(c.leadsRequired) + '</div><div class="l">leads chosen</div></div>'
      + "</div>";

    if (d.partial) {
      html += '<div class="warn">You can see this whole lineup because the duties\u2019 minimums are shared '
        + "across " + esc((d.regions || []).join(" and ")) + ", but you can only change volunteers in your own "
        + "region. Everyone else is shown as read-only. Ask an admin if you need the rest.</div>";
    }
    if (c.leadsRequired && c.leadsChosen < c.leadsRequired) {
      html += '<div class="warn"><b>' + num(c.leadsRequired - c.leadsChosen) + " lead(s) still to pick.</b> "
        + "The allocation never chooses leads \u2014 move whoever you want into the <b>Lead \u2013</b> duties below. "
        + "They are extra people, and check in an hour before their duty.</div>";
    }
    html += "</div>";

    // ---- the duties ----
    html += '<div class="sub2">Duties</div><div class="scrollx">'
      + '<table class="matrix"><tr><th>Duty</th><th class="n">Have</th><th class="n">Need</th>'
      + '<th class="n">Short</th><th class="n">Min age</th><th>Check-in</th></tr>'
      + d.duties.map(function (x) {
          return "<tr" + (x.isLead ? ' style="color:#4b5563"' : "") + "><td>" + esc(x.duty)
            + (x.isLead ? ' <span class="small">\u2014 lead of ' + esc(x.leadOf) + "</span>" : "")
            + '</td><td class="n">' + num(x.assigned) + '</td><td class="n">' + num(x.min) + '</td>'
            + '<td class="n">' + (x.shortfall ? '<b style="color:#9b5b50">' + num(x.shortfall) + "</b>" : "\u2014")
            + '</td><td class="n">' + (x.minAge ? num(x.minAge) + "+" : '<span class="small">any</span>') + "</td>"
            + "<td>" + (x.checkIn ? esc(x.checkIn) : '<span style="color:#9b5b50">not set</span>') + "</td></tr>";
        }).join("")
      + "</table></div>";

    if ((d.offRoster || []).length) {
      html += '<div class="warn"><b>Not on the roster any more:</b> '
        + d.offRoster.map(function (x) { return esc(x.duty) + " (" + num(x.assigned) + ")"; }).join(", ")
        + " \u2014 move these people onto a rostered duty.</div>";
    }

    // ---- the people ----
    var shown = d.people.filter(matches);
    html += '<div class="sub2">Who\u2019s in it</div><div class="scrollx">'
      + '<table class="matrix"><tr><th>Name</th><th>Jamatkhana</th><th class="n">Age</th>'
      + "<th>Duty</th><th>State</th><th>Asked for</th></tr>"
      + (shown.length ? "" : '<tr><td colspan="6"><span class="small">Nobody matches these filters.</span></td></tr>')
      + shown.map(function (p) {
          var wants = (p.wants || []).length ? esc(p.wants.join(", ")) : '<span class="small">\u2014</span>';
          if (p.assigned) wants = '<b>' + esc(p.assigned) + '</b> <span class="small">(given by a caller)</span>'
            + ((p.wants || []).length ? '<br><span class="small">' + esc(p.wants.join(", ")) + "</span>" : "");
          return "<tr><td>" + esc(p.name) + "</td><td>" + (p.jk ? esc(p.jk) : '<span class="small">\u2014</span>')
            + '</td><td class="n">' + (p.age == null ? '<span class="small" style="color:#9b5b50">no DOB</span>' : num(p.age))
            + "</td><td>" + dutyCell(p, d.duties) + "</td><td>" + stateChip(p) + "</td><td>" + wants + "</td></tr>";
        }).join("")
      + "</table></div>"
      + '<div class="small" style="margin-top:6px">Ages are age on the day of the event ('
      + esc(d.asOf) + "), which is what every age limit is measured against.</div>";

    EL("out").innerHTML = html;
    // The counts above are the WHOLE lineup on purpose — a filtered "3 short" would be a lie. Say
    // plainly when the table is showing less than everything.
    EL("fcount").textContent = shown.length === d.people.length
      ? num(d.people.length) + " people"
      : num(shown.length) + " of " + num(d.people.length) + " shown \u2014 counts above are the whole lineup";
    Array.prototype.forEach.call(document.querySelectorAll(".dutysel"), function (sel) {
      sel.addEventListener("change", function () { reassign(sel); });
    });
  }

  function reassign(sel) {
    clearBanner();
    var id = sel.getAttribute("data-id"), region = sel.getAttribute("data-region"), duty = sel.value;
    sel.disabled = true;
    fetch("/api/dutyreview", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "reassign", session: session(), area: area(), user_id: id, region: region, duty: duty }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        sel.disabled = false;
        if (d.error) { banner(esc(d.error), true); show(); return; }
        // An age override is not a failure — it is a decision, and it is on the record.
        if (d.note) banner(esc(d.note), true);
        show();          // reload: the counts, shortfalls and leads all just moved
      })
      .catch(function (e) { sel.disabled = false; banner("Couldn\u2019t save: " + esc(e.message), true); show(); });
  }

  function submit() {
    clearBanner();
    if (!VIEW) return;
    var c = VIEW.counts;
    var msg = "Submit " + num(c.allocated) + " volunteer(s) to iVolunteer for " + area() + "?";
    if (c.pending) msg += "\n\n" + num(c.pending) + " have no duty yet and will NOT be submitted.";
    if (c.leadsChosen < c.leadsRequired) msg += "\n\n" + num(c.leadsRequired - c.leadsChosen)
      + " lead(s) are still unpicked. You can submit now and pick them later.";
    msg += "\n\nYou can keep changing people until iVol enters their duty.";
    if (!confirm(msg)) return;
    EL("submitBtn").disabled = true;
    fetch("/api/dutyreview", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "submit", session: session(), area: area() }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { banner(esc(d.error), true); EL("submitBtn").disabled = false; return; }
        banner(esc(d.note), !!(d.pending || d.skipped));
        show();
      })
      .catch(function (e) { banner("Failed: " + esc(e.message), true); EL("submitBtn").disabled = false; });
  }

  function reFilter() { if (VIEW) { buildFilterOptions(VIEW); render(VIEW); } }
  EL("q").addEventListener("input", function (e) { filters.q = e.target.value.toLowerCase(); reFilter(); });
  EL("fRegion").addEventListener("change", function (e) { filters.region = e.target.value; filters.jk = ""; reFilter(); });
  EL("fJk").addEventListener("change", function (e) { filters.jk = e.target.value; reFilter(); });
  EL("fDuty").addEventListener("change", function (e) { filters.duty = e.target.value; reFilter(); });
  EL("fState").addEventListener("change", function (e) { filters.state = e.target.value; reFilter(); });
  EL("fMine").addEventListener("change", function (e) { filters.mine = e.target.checked; reFilter(); });

  function clearView() { VIEW = null; EL("out").innerHTML = ""; EL("filters").hidden = true; EL("submitBtn").disabled = true; }
  EL("event").addEventListener("change", function () { fillAreas(); clearView(); });
  EL("area").addEventListener("change", clearView);
  EL("loadBtn").addEventListener("click", show);
  EL("submitBtn").addEventListener("click", submit);
  load();
})();
