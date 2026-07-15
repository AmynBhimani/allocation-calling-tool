(function () {
  var SESSIONS = [], LAST = null;
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }
  function current() { return EL("event").value || ""; }

  function showScope() {
    var s = SESSIONS.filter(function (x) { return x.id === current(); })[0];
    if (!s) { EL("scope").textContent = SESSIONS.length ? "" : "No sessions configured \u2014 add them on the Events screen."; return; }
    var n = (s.areasWithRoster || []).length;
    EL("scope").textContent = n
      ? n + " area" + (n === 1 ? "" : "s") + " with an imported duty roster"
      : "No duty roster imported for this session yet \u2014 do that on the Duty rosters screen first.";
  }

  function load() {
    return fetch("/api/dutyalloc").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { banner(esc(d.error), true); return; }
      SESSIONS = (d && d.sessions) || [];
      EL("event").innerHTML = SESSIONS.length
        ? SESSIONS.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>"; }).join("")
        : '<option value="">(no sessions configured)</option>';
      showScope();
    }).catch(function () { EL("scope").textContent = "Couldn\u2019t load sessions."; });
  }

  function run(commit) {
    clearBanner();
    var ev = current();
    if (!ev) { banner("Pick a session.", true); return; }
    if (commit && !confirm("Commit duty allocation for this session? Anyone who already has a duty keeps it.")) return;
    EL("runBtn").disabled = true; EL("commitBtn").disabled = true;
    EL("out").innerHTML = '<div class="card"><div class="small">' + (commit ? "Committing" : "Working") + "\u2026</div></div>";
    fetch("/api/dutyalloc", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: ev, commit: !!commit }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { EL("out").innerHTML = ""; banner(esc(d.error), true); EL("runBtn").disabled = false; return; }
        LAST = d; render(d);
        EL("runBtn").disabled = false;
        EL("commitBtn").disabled = !!commit;
        if (commit) banner("Committed. " + num(d.counts.placed) + " volunteer(s) given a duty \u2014 the areas can review their lineups now.", false);
      })
      .catch(function (e) { EL("out").innerHTML = ""; banner("Failed: " + esc(e.message), true); EL("runBtn").disabled = false; });
  }

  function areaTable(a) {
    return '<div class="scrollx"><table class="matrix">'
      + '<tr><th>Duty</th><th class="n">Minimum</th><th class="n">Assigned</th><th class="n">Short</th><th class="n">Asked for it</th><th class="n">Leads</th></tr>'
      + a.duties.map(function (d) {
          return "<tr><td>" + esc(d.duty) + '</td><td class="n">' + num(d.min) + '</td><td class="n">' + num(d.assigned)
            + '</td><td class="n">' + (d.shortfall ? '<b style="color:#9b5b50">' + num(d.shortfall) + "</b>" : "\u2014")
            + '</td><td class="n">' + num(d.requested) + '</td><td class="n">' + num(d.leadsChosen) + " / " + num(d.leadsRequired) + "</td></tr>";
        }).join("")
      + '<tr class="tot"><td>All duties</td><td class="n">' + num(a.minTotal) + '</td><td class="n">' + num(a.assignedTotal)
      + '</td><td class="n">' + (a.shortfallTotal ? num(a.shortfallTotal) : "\u2014") + '</td><td class="n"></td><td class="n">'
      + num(a.leadsChosenTotal) + " / " + num(a.leadsRequiredTotal) + "</td></tr></table></div>";
  }

  function render(d) {
    var c = d.counts || {};
    var html = '<div class="card">';
    html += '<div class="small">' + esc(d.sessionName || "") + " \u00b7 " + (d.regions || []).join(", ")
      + " \u00b7 <b>" + esc(d.mode === "commit" ? "committed" : "preview") + "</b></div>";
    html += '<div class="kpis">'
      + '<div class="kpi"><div class="n">' + num(c.members) + '</div><div class="l">in this session</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.placed) + '</div><div class="l">given a duty now</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.alreadyPlaced) + '</div><div class="l">already had one</div></div>'
      + (c.locked ? '<div class="kpi"><div class="n">' + num(c.locked) + '</div><div class="l">locked (in iVolunteer)</div></div>' : "")
      + (d.shortfallTotal ? '<div class="kpi flag"><div class="n">' + num(d.shortfallTotal) + '</div><div class="l">short of minimums</div></div>' : "")
      + (c.noRoster ? '<div class="kpi flag"><div class="n">' + num(c.noRoster) + '</div><div class="l">no roster for their area</div></div>' : "")
      + "</div>";
    html += '<div class="small">' + esc(d.note || "") + "</div>";

    if (d.shortfallTotal) {
      html += '<div class="warn"><b>' + num(d.shortfallTotal) + " place(s) short of the minimums.</b> "
        + "There aren\u2019t enough people in this session to meet every floor \u2014 either the minimums are too high, or more volunteers need to accept. "
        + "The areas can still review what\u2019s there.</div>";
    }
    if ((d.areasWithoutRoster || []).length) {
      html += '<div class="warn"><b>No duty roster imported for:</b> '
        + d.areasWithoutRoster.map(function (a) { return esc(a.area) + " (" + num(a.members) + " people)"; }).join(", ")
        + ". Those people were left alone \u2014 import their template on the Duty rosters screen, then run this again.</div>";
    }
    if (!d.shortfallTotal && !(d.areasWithoutRoster || []).length && c.members) {
      html += '<div class="good">Every minimum is met.</div>';
    }
    html += '<div class="small" style="margin-top:10px">'
      + num(c.byRequest) + " placed into a duty they asked for \u00b7 " + num(c.byFill) + " filling a minimum \u00b7 "
      + num(c.bySpread) + " spread across the rest</div>";

    (d.areas || []).forEach(function (a) {
      html += '<div class="sub2">' + esc(a.area) + " \u00b7 " + num(a.members) + " people</div>" + areaTable(a);
      if ((a.offRoster || []).length) {
        html += '<div class="small" style="color:#9b5b50">Held but no longer on the roster: '
          + a.offRoster.map(function (x) { return esc(x.duty) + " (" + num(x.assigned) + ")"; }).join(", ") + "</div>";
      }
    });
    if (d.mode === "commit") {
      html += '<div class="small" style="margin-top:10px">Written: '
        + Object.keys(d.written || {}).map(function (R) { return esc(R) + " " + num(d.written[R]); }).join(" \u00b7 ") + "</div>";
    }
    html += "</div>";
    EL("out").innerHTML = html;
  }

  fetch("/.auth/me").then(function (r) { return r.json(); }).then(function (me) {
    var cp = me && me.clientPrincipal;
    if (cp) EL("whoami").innerHTML = "<b>" + esc(cp.userDetails) + "</b>";
  }).catch(function () {});

  EL("event").addEventListener("change", function () { showScope(); EL("commitBtn").disabled = true; EL("out").innerHTML = ""; });
  EL("runBtn").addEventListener("click", function () { run(false); });
  EL("commitBtn").addEventListener("click", function () { run(true); });
  load();
})();
