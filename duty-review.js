// Duty review — an area's lineup for one session: who is on what, what is short, and who leads.
//
// Reassigning saves IMMEDIATELY, one person at a time. No bulk apply, deliberately: a lineup gets
// picked over a few people at a time by someone on a phone between other things, and a half-filled
// form that loses its changes on a stray reload is worse than a save per row.
(function () {
  var SESSIONS = [], VIEW = null;
  // Same filter model as the iVol Input Report, so the two screens behave identically: filtering is
  // client-side over the loaded lineup, and the JK list narrows to the chosen region.
  var filters = { q: "", region: "", jk: "", group: "", duty: "", state: "", mine: false };
  // Whether the duties summary is open has to live HERE, not be read back off the DOM: show() paints
  // a loading state over the box before re-rendering, so by then the <details> is already gone and
  // any state read from it would always come back "open".
  var dutiesOpen = true;
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
    // Remember whether the summary was collapsed BEFORE painting over it. Every reassign re-runs
    // show(), and a summary that springs back open on every change is worse than not collapsing at all.
    if (EL("dutiesBox")) dutiesOpen = EL("dutiesBox").open;
    EL("summaryBox").innerHTML = '<div class="card"><div class="small">Loading\u2026</div></div>';
    EL("peopleBox").innerHTML = "";
    fetch("/api/dutyreview?session=" + encodeURIComponent(session()) + "&area=" + encodeURIComponent(area()))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { clearView(); banner(esc(d.error), true); return; }
        VIEW = d;
        EL("filters").hidden = false;
        EL("fMine").parentNode.hidden = !d.partial;   // pointless when you can change everyone
        buildFilterOptions(d);
        render(d);
        EL("submitBtn").disabled = !d.counts.allocated;
      })
      .catch(function (e) { clearView(); banner("Failed: " + esc(e.message), true); });
  }

  // One person's duty dropdown. Locked rows and rows outside your regions render as plain text —
  // a disabled control the reader can't explain is worse than no control.
  function dutyCell(p, duties) {
    if (p.locked) {
      return esc(p.duty) + ' <span class="small">\u2014 ' + STATE.entered.label + ", locked</span>";
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

  // The four states, named for what they MEAN to the person reading them rather than for the value
  // stored. "submitted" and "entered" are indistinguishable words for two very different situations:
  // one you can still change, one you cannot. One map, used by the chip, the counters and the filter,
  // so the three can never tell you different things about the same person.
  var STATE = {
    pending:   { label: "No duty yet",       kpi: "no duty yet" },
    allocated: { label: "Not on lineup yet", kpi: "not on lineup yet" },
    submitted: { label: "On iVol Lineup",    kpi: "on iVol lineup" },
    entered:   { label: "Assigned in iVol",  kpi: "assigned in iVol" },
  };
  // The state a row is IN, from the data — one place, so the chip and the filter agree by construction.
  function stateOf(p) {
    if (p.locked) return "entered";
    if (p.state === "submitted") return "submitted";
    return p.duty ? "allocated" : "pending";
  }
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
    // fState's options are fixed and live in the page — the four states never vary by lineup.
    // A region filter is noise on a single-region session, but the cross-region ones need it badly.
    EL("fRegion").hidden = (d.regions || []).length < 2;
  }
  // Same four groups as every other screen's filter, matched against the labels the server derives.
  var GROUP_LABEL = { iff: "IFF", seniors: "Seniors", young: "Young", diverse: "Diverse Abilities" };
  function matches(p) {
    if (filters.q && p.name.toLowerCase().indexOf(filters.q) < 0) return false;
    if (filters.region && p.region !== filters.region) return false;
    if (filters.jk && p.jk !== filters.jk) return false;
    if (filters.group && (p.groups || []).indexOf(GROUP_LABEL[filters.group]) < 0) return false;
    if (filters.duty === NODUTY) { if (p.duty) return false; }
    else if (filters.duty && p.duty !== filters.duty) return false;
    if (filters.state && stateOf(p) !== filters.state) return false;
    if (filters.mine && (!p.canEdit || p.locked)) return false;
    return true;
  }

  function stateChip(p) {
    var st = stateOf(p);
    // For a row this person can change AND that has a duty, the state IS a control: a checkbox that
    // puts them on the iVol lineup or takes them back off. Saved immediately, so a lineup can be
    // committed a few people at a time, by different reviewers, each seeing what the last one did.
    // Entered is the wall (locked, no toggle); pending has no duty yet, so nothing to commit.
    if (p.canEdit && st !== "entered" && p.duty) {
      var on = (st === "submitted");
      // A lineup entry is sent to Better Impact for iVol entry, so it needs a BI account. Someone without
      // one gets the reason in place of the toggle — never the control. (If somehow already on the lineup,
      // still let it be turned OFF so a bad state can be cleared.)
      if (p.no_bi_account && !on) {
        return '<span class="small" style="color:#9b5b50" title="A lineup entry goes to Better Impact for iVol entry, so a BI account is required first.">Needs a BI account</span>';
      }
      return '<label class="linetoggle' + (on ? " on" : "") + '">'
        + '<input type="checkbox" class="linechk" data-id="' + esc(p.user_id) + '" data-region="' + esc(p.region) + '"' + (on ? " checked" : "") + ">"
        + '<span>' + (on ? STATE.submitted.label : "Add to lineup") + "</span></label>";
    }
    if (st === "entered") return '<span class="small" style="color:#1E6C57">' + STATE.entered.label + "</span>";
    if (st === "pending") return '<span class="small" style="color:#9b5b50">' + STATE.pending.label + "</span>";
    return '<span class="small">' + STATE[st].label + "</span>";
  }

  // Two renders, not one. The summary is rebuilt when a lineup loads; the people table on every
  // filter change. Keeping them apart is what lets the filter bar sit BETWEEN them without being
  // destroyed and re-created on each keystroke — which would take the search box's focus with it.
  function render(d) { renderSummary(d); renderPeople(d); }

  function renderSummary(d) {
    var c = d.counts, html = "";

    html += '<div class="card">';
    html += '<div class="kpis">'
      + '<div class="kpi"><div class="n">' + num(c.members) + '</div><div class="l">in this lineup</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.allocated) + '</div><div class="l">' + STATE.allocated.kpi + "</div></div>"
      + '<div class="kpi"><div class="n">' + num(c.submitted) + '</div><div class="l">' + STATE.submitted.kpi + "</div></div>"
      + '<div class="kpi"><div class="n">' + num(c.entered) + '</div><div class="l">' + STATE.entered.kpi + " \u2014 locked</div></div>"
      + (c.pending ? '<div class="kpi flag"><div class="n">' + num(c.pending) + '</div><div class="l">' + STATE.pending.kpi + "</div></div>" : "")
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
    // Collapsible, open by default: it is the first thing you look at and the first thing you want
    // out of the way once you are working down the list of people.
    html += '<details id="dutiesBox"' + (dutiesOpen ? " open" : "")
      + '><summary class="sub2" style="display:list-item;cursor:pointer">'
      + "Duties \u2014 " + num(d.duties.length) + " on this roster"
      + (c.shortfallTotal ? ", <b>" + num(c.shortfallTotal) + "</b> place(s) to fill" : ", all filled")
      + '</summary><div class="scrollx">'
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
      + "</table></div></details>";

    if ((d.offRoster || []).length) {
      html += '<div class="warn"><b>Not on the roster any more:</b> '
        + d.offRoster.map(function (x) { return esc(x.duty) + " (" + num(x.assigned) + ")"; }).join(", ")
        + " \u2014 move these people onto a rostered duty.</div>";
    }

    EL("summaryBox").innerHTML = html;
  }

  function renderPeople(d) {
    var shown = d.people.filter(matches);
    // Lead duties (the review tool's own leads): map each lead duty's exact name -> what it leads, so a
    // person sitting in one gets a "Lead" badge alongside the "Team Lead" badge carried from the upload.
    var leadDutyNames = {};
    (d.duties || []).forEach(function (x) { if (x.isLead) leadDutyNames[x.duty] = x.leadOf || ""; });
    EL("peopleBox").innerHTML = '<div class="sub2">Who\u2019s in it</div><div class="scrollx">'
      + '<table class="matrix"><tr><th>Name</th><th>Jamatkhana</th><th>Group</th><th class="n">Age</th>'
      + "<th>Duty</th><th>State</th><th>Asked for</th></tr>"
      + (shown.length ? "" : '<tr><td colspan="7"><span class="small">Nobody matches these filters.</span></td></tr>')
      + shown.map(function (p) {
          var wants = (p.wants || []).length ? esc(p.wants.join(", ")) : '<span class="small">\u2014</span>';
          if (p.assigned) wants = '<b>' + esc(p.assigned) + '</b> <span class="small">(given by a caller)</span>'
            + ((p.wants || []).length ? '<br><span class="small">' + esc(p.wants.join(", ")) + "</span>" : "");
          // Someone can be on more than one list — an IFF senior — so show every one they are on.
          var groups = (p.groups || []).length ? esc(p.groups.join(", ")) : '<span class="small">General</span>';
          var badges = "";
          if (p.leader) badges += ' <span class="badge b-lead" title="Identified as a team lead in the roster upload">Team Lead</span>';
          if (p.duty && (p.duty in leadDutyNames)) badges += ' <span class="badge b-leadduty" title="Assigned as a lead' + (leadDutyNames[p.duty] ? " of " + esc(leadDutyNames[p.duty]) : "") + ' on this screen">Lead</span>';
          // Their duty was removed by a roster upload and they were moved to unassigned. Shown only while
          // they still have no duty, so it clears itself the moment they are placed again.
          if (p.needsReassign && !p.duty) badges += ' <span class="badge b-reassign" title="Their duty' + (p.reassignFrom ? " (" + esc(p.reassignFrom) + ")" : "") + ' was removed from the roster \u2014 assign them a new one">Reassign</span>';
          return "<tr><td>" + esc(p.name) + badges + "</td><td>" + (p.jk ? esc(p.jk) : '<span class="small">\u2014</span>')
            + "</td><td>" + groups + "</td>"
            + '<td class="n">' + (p.age == null ? '<span class="small" style="color:#9b5b50">no DOB</span>' : num(p.age))
            + "</td><td>" + dutyCell(p, d.duties) + "</td><td>" + stateChip(p) + "</td><td>" + wants + "</td></tr>";
        }).join("")
      + "</table></div>"
      + '<div class="small" style="margin-top:6px">Ages are age on the day of the event ('
      + esc(d.asOf) + "), which is what every age limit is measured against.</div>";

    // The counts in the summary are the WHOLE lineup on purpose — a filtered "3 short" would be a
    // lie. Say plainly when the table is showing less than everything.
    EL("fcount").textContent = shown.length === d.people.length
      ? num(d.people.length) + " people"
      : num(shown.length) + " of " + num(d.people.length) + " shown \u2014 counts above are the whole lineup";
    Array.prototype.forEach.call(document.querySelectorAll(".dutysel"), function (sel) {
      sel.addEventListener("change", function () { reassign(sel); });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".linechk"), function (cb) {
      cb.addEventListener("change", function () { setLineup(cb); });
    });
  }

  function setLineup(cb) {
    clearBanner();
    var id = cb.getAttribute("data-id"), region = cb.getAttribute("data-region"), on = cb.checked;
    cb.disabled = true;
    fetch("/api/dutyreview", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "set_lineup", session: session(), area: area(), user_id: id, region: region, on: on }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        cb.disabled = false;
        if (d.error) { banner(esc(d.error), true); show(); return; }
        show();          // reload: the on-lineup / not-on-lineup counts just changed
      })
      .catch(function (e) { cb.disabled = false; banner("Couldn\u2019t save: " + esc(e.message), true); show(); });
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
    var msg = "Put " + num(c.allocated) + " volunteer(s) on the iVol lineup for " + area() + "?";
    if (c.pending) msg += "\n\n" + num(c.pending) + " have no duty yet and will NOT be submitted.";
    if (c.leadsChosen < c.leadsRequired) msg += "\n\n" + num(c.leadsRequired - c.leadsChosen)
      + " lead(s) are still unpicked. You can submit now and pick them later.";
    msg += "\n\nYou can still change anyone on the lineup \u2014 until iVol assigns their duty, "
      + "at which point that person is locked.";
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

  function reFilter() { if (VIEW) renderPeople(VIEW); }
  function reFilterRegion() { if (VIEW) { buildFilterOptions(VIEW); renderPeople(VIEW); } }
  EL("q").addEventListener("input", function (e) { filters.q = e.target.value.toLowerCase(); reFilter(); });
  EL("fRegion").addEventListener("change", function (e) { filters.region = e.target.value; filters.jk = ""; reFilterRegion(); });
  EL("groupSel").addEventListener("change", function (e) { filters.group = e.target.value; reFilter(); });
  EL("fJk").addEventListener("change", function (e) { filters.jk = e.target.value; reFilter(); });
  EL("fDuty").addEventListener("change", function (e) { filters.duty = e.target.value; reFilter(); });
  EL("fState").addEventListener("change", function (e) { filters.state = e.target.value; reFilter(); });
  EL("fMine").addEventListener("change", function (e) { filters.mine = e.target.checked; reFilter(); });

  function clearView() {
    VIEW = null; EL("summaryBox").innerHTML = ""; EL("peopleBox").innerHTML = "";
    EL("filters").hidden = true; EL("submitBtn").disabled = true;
  }
  EL("event").addEventListener("change", function () { fillAreas(); clearView(); });
  EL("area").addEventListener("change", clearView);
  EL("loadBtn").addEventListener("click", show);
  EL("submitBtn").addEventListener("click", submit);
  load();
})();
