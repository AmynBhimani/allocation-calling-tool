// Duty review — an area's lineup for one session: who is on what, what is short, and who leads.
//
// Reassigning saves IMMEDIATELY, one person at a time. No bulk apply, deliberately: a lineup gets
// picked over a few people at a time by someone on a phone between other things, and a half-filled
// form that loses its changes on a stray reload is worse than a save per row.
(function () {
  var SESSIONS = [], VIEW = null;
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
        VIEW = d; render(d);
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
    html += '<div class="sub2">Who\u2019s in it</div><div class="scrollx">'
      + '<table class="matrix"><tr><th>Name</th><th>Jamatkhana</th><th class="n">Age</th>'
      + "<th>Duty</th><th>State</th><th>Asked for</th></tr>"
      + d.people.map(function (p) {
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

  EL("event").addEventListener("change", function () { fillAreas(); EL("out").innerHTML = ""; EL("submitBtn").disabled = true; });
  EL("area").addEventListener("change", function () { EL("out").innerHTML = ""; EL("submitBtn").disabled = true; });
  EL("loadBtn").addEventListener("click", show);
  EL("submitBtn").addEventListener("click", submit);
  load();
})();
