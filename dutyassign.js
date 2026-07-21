// Assign Duties — mass duty assignment. Reuses the duty-review GET for the picker, the area's roster (the
// duty dropdown) and its people; the action is a new assign_bulk op on /api/dutyreview. Only people on the
// roster who aren't yet on the lineup (pending/allocated, and editable by you) are shown and assignable.
(function () {
  var SESSIONS = [], VIEW = null, selected = {}, busy = false;
  var filters = { q: "", noDutyOnly: false };
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(m, e) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (e ? " err" : ""); b.innerHTML = m; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }
  function session() { return EL("event").value || ""; }
  function area() { return EL("area").value || ""; }

  function boot() {
    fetch("/.auth/me").then(function (r) { return r.json(); }).then(function (m) {
      var cp = m && m.clientPrincipal; if (cp) EL("whoami").innerHTML = "<b>" + esc(cp.userDetails) + "</b>";
    }).catch(function () {});
    load();
  }
  function load() {
    return fetch("/api/dutyreview").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { banner(esc(d.error), true); return; }
      SESSIONS = (d && d.sessions) || [];
      EL("event").innerHTML = SESSIONS.length
        ? SESSIONS.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join("")
        : '<option value="">(no sessions)</option>';
      syncAreas();
    }).catch(function () { banner("Couldn\u2019t load sessions.", true); });
  }
  function syncAreas() {
    var s = SESSIONS.filter(function (x) { return x.id === session(); })[0];
    var areas = (s && s.areas) || [];
    EL("area").innerHTML = areas.length
      ? areas.map(function (a) { return '<option value="' + esc(a) + '">' + esc(a) + '</option>'; }).join("")
      : '<option value="">(no areas you can assign)</option>';
    EL("area").disabled = !areas.length; EL("loadBtn").disabled = !areas.length;
    EL("scope").textContent = areas.length ? "" : "No area in this session has a duty roster you can assign.";
  }

  function eligible(p) { return p.canEdit && (p.state === "pending" || p.state === "allocated"); }
  function pool() { return (VIEW.people || []).filter(eligible); }
  function matches(p) {
    if (filters.noDutyOnly && p.duty) return false;
    if (filters.q) { var q = filters.q.toLowerCase(); if ((p.name || "").toLowerCase().indexOf(q) < 0 && (p.jk || "").toLowerCase().indexOf(q) < 0) return false; }
    return true;
  }
  function chosenDuty() { return EL("dutySel") ? EL("dutySel").value : ""; }
  function selectedIds() { return Object.keys(selected).filter(function (k) { return selected[k]; }); }

  function show() {
    if (!session() || !area()) return;
    selected = {};
    EL("results").innerHTML = '<div class="card"><div class="small">Loading\u2026</div></div>';
    fetch("/api/dutyreview?session=" + encodeURIComponent(session()) + "&area=" + encodeURIComponent(area()))
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { EL("results").innerHTML = ""; banner(esc(d.error), true); return; }
        VIEW = d; renderShell(); renderTable();
      }).catch(function () { EL("results").innerHTML = ""; banner("Couldn\u2019t load the roster.", true); });
  }

  // The shell (duty dropdown, assign button, filters) is built once per load and NOT rebuilt on filter or
  // selection changes — so the search box keeps focus as you type. Only #tableBox re-renders.
  function renderShell() {
    var duties = VIEW.duties || [];
    var dutyOpts = duties.map(function (x) {
      var label = x.duty + (x.isLead ? " (lead)" : "") + " \u2014 min " + num(x.min) + (x.minAge ? ", " + num(x.minAge) + "+" : "");
      return '<option value="' + esc(x.duty) + '">' + esc(label) + '</option>';
    }).join("");
    EL("results").innerHTML =
      '<div class="card">' +
        '<div class="assignbar">' +
          '<div class="field"><label>Assign to duty</label><select id="dutySel">' + (dutyOpts || '<option value="">(no duties on this roster)</option>') + '</select></div>' +
          '<button class="btn commit" id="assignBtn" disabled>Assign selected</button>' +
          '<span class="small" id="selCount"></span>' +
        '</div>' +
        '<div id="assignResult"></div>' +
        '<div class="filters">' +
          '<input type="text" id="q" placeholder="Search name or Jamatkhana">' +
          '<label class="chk"><input type="checkbox" id="noDutyOnly"> Only people without a duty</label>' +
          '<span class="small" id="fcount" style="margin-left:auto"></span>' +
        '</div>' +
        '<div id="tableBox"></div>' +
      '</div>';
    EL("dutySel").addEventListener("change", refreshBtn);
    EL("q").addEventListener("input", function (e) { filters.q = e.target.value; renderTable(); });
    EL("noDutyOnly").addEventListener("change", function (e) { filters.noDutyOnly = e.target.checked; renderTable(); });
    EL("assignBtn").addEventListener("click", assign);
  }

  function renderTable() {
    var p = pool(), shown = p.filter(matches);
    EL("tableBox").innerHTML =
      '<div class="scrollx"><table class="matrix">' +
        '<tr><th class="c"><input type="checkbox" id="selAll"></th><th>Name</th><th>Jamatkhana</th><th class="n">Age</th><th>Current duty</th><th>Asked for</th></tr>' +
        (shown.length ? shown.map(rowFor).join("") : '<tr><td colspan="6"><span class="small">Nobody on this roster is waiting for a duty' + (filters.q || filters.noDutyOnly ? " under these filters" : "") + '.</span></td></tr>') +
      '</table></div>';
    EL("selAll").addEventListener("change", function (e) { shown.forEach(function (pp) { selected[pp.user_id] = e.target.checked; }); renderTable(); });
    Array.prototype.forEach.call(document.querySelectorAll(".rsel"), function (cb) {
      cb.addEventListener("change", function () { selected[cb.getAttribute("data-id")] = cb.checked; refreshBtn(); updateSelAll(shown); });
    });
    refreshBtn(); updateSelAll(shown);
    EL("fcount").textContent = shown.length === p.length ? num(p.length) + " waiting" : num(shown.length) + " of " + num(p.length) + " shown";
  }

  function rowFor(p) {
    var checked = selected[p.user_id] ? " checked" : "";
    var dutyCell = p.duty ? '<span class="pill alloc">' + esc(p.duty) + '</span>' : '<span class="pill none">No duty</span>';
    var wants = (p.wants || []).length ? esc(p.wants.join(", ")) : (p.assigned ? '<b>' + esc(p.assigned) + '</b> <span class="small">(caller)</span>' : '<span class="small">\u2014</span>');
    return '<tr><td class="c"><input type="checkbox" class="rsel" data-id="' + esc(p.user_id) + '"' + checked + '></td>' +
      '<td>' + esc(p.name) + '</td><td>' + (p.jk ? esc(p.jk) : '<span class="small">\u2014</span>') + '</td>' +
      '<td class="n">' + (p.age == null ? '<span class="small" style="color:#9b5b50">no DOB</span>' : num(p.age)) + '</td>' +
      '<td>' + dutyCell + '</td><td>' + wants + '</td></tr>';
  }

  function refreshBtn() {
    var n = selectedIds().length, duty = chosenDuty(), btn = EL("assignBtn");
    if (EL("selCount")) EL("selCount").textContent = n ? num(n) + " selected" : "";
    if (btn) { btn.disabled = !(n && duty); btn.textContent = (n && duty) ? "Assign " + num(n) + " to " + duty : "Assign selected"; }
  }
  function updateSelAll(shown) { var all = shown.length && shown.every(function (pp) { return selected[pp.user_id]; }); if (EL("selAll")) EL("selAll").checked = !!all; }

  function assign() {
    var ids = selectedIds(), duty = chosenDuty();
    if (!ids.length || !duty) return;
    var byId = {}; (VIEW.people || []).forEach(function (p) { byId[p.user_id] = p; });
    var items = ids.map(function (id) { return byId[id] ? { user_id: id, region: byId[id].region } : null; }).filter(Boolean);
    if (!window.confirm("Assign " + num(items.length) + " volunteer(s) to " + duty + "?")) return;
    if (busy) return; busy = true; EL("assignBtn").disabled = true; clearBanner();
    EL("assignResult").innerHTML = '<div class="small" style="margin-top:8px">Assigning\u2026</div>';
    fetch("/api/dutyreview", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "assign_bulk", session: session(), area: area(), duty: duty, items: items }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        busy = false;
        if (d.error) { EL("assignResult").innerHTML = ""; banner(esc(d.error), true); refreshBtn(); return; }
        var sk = d.skipped || {}; var skTot = (sk.locked || 0) + (sk.onLineup || 0) + (sk.notInSession || 0) + (sk.wrongArea || 0) + (sk.outOfScope || 0);
        var msg = "Assigned <b>" + num(d.assigned) + "</b> to " + esc(d.duty) + ".";
        if (d.tooYoung) msg += " <b>" + num(d.tooYoung) + "</b> under the " + num(d.minAge) + "+ guideline (allowed, logged).";
        if (skTot) msg += " " + num(skTot) + " skipped (already on the lineup, locked, or moved).";
        if (d.failed) msg += " <b>" + num(d.failed) + "</b> couldn\u2019t be saved \u2014 reload and retry.";
        EL("assignResult").innerHTML = '<div class="' + ((d.tooYoung || d.failed) ? "warnbox" : "good") + '" style="margin-top:10px">' + msg + '</div>';
        selected = {}; setTimeout(show, 700);
      }).catch(function () { busy = false; EL("assignResult").innerHTML = ""; banner("The assign request failed \u2014 reload and retry.", true); refreshBtn(); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    EL("event").addEventListener("change", syncAreas);
    EL("loadBtn").addEventListener("click", show);
    boot();
  });
})();
