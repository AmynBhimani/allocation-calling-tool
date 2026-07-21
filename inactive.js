// Inactive Volunteers — list everyone set aside (inactive) or blocked, and Activate the inactive ones when
// they register. Server does the work (/api/inactive, shared/disposition activate); this is list + buttons.
(function () {
  var VIEW = null, busy = false;
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }

  function load() {
    clearBanner();
    fetch("/api/inactive").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { EL("results").innerHTML = ""; banner(esc(d.error), true); return; }
      VIEW = d; render(d);
    }).catch(function () { EL("results").innerHTML = ""; banner("Couldn\u2019t load the list.", true); });
  }

  function personRow(p) {
    var isInactive = p.assignability === "inactive";
    var pill = '<span class="pill ' + esc(p.assignability) + '">' + (isInactive ? "Inactive" : "Blocked") + "</span>";
    var act = isInactive
      ? '<input type="checkbox" class="sel" data-id="' + esc(p.user_id) + '"> '
        + '<button class="btn sm act" data-id="' + esc(p.user_id) + '">Activate</button>'
      : '<span class="small">\u2014</span>';
    return '<tr>' +
      '<td>' + esc(p.name) + '</td>' +
      '<td>' + esc(p.region) + '</td>' +
      '<td>' + esc(p.jk || "\u2014") + '</td>' +
      '<td>' + esc(p.area || "\u2014") + '</td>' +
      '<td>' + pill + '</td>' +
      '<td class="small">' + esc(p.reason || "\u2014") + '</td>' +
      '<td>' + act + '</td></tr>';
  }

  function render(d) {
    EL("scope").textContent = "Regions in scope: " + (d.regions || []).join(", ");
    var c = d.counts || {};
    if (!c.total) {
      EL("results").innerHTML = '<div class="card"><div class="good" style="margin:0">No inactive or blocked volunteers.</div></div>';
      return;
    }
    var people = d.people || [];
    var hasInactive = people.some(function (p) { return p.assignability === "inactive"; });
    EL("results").innerHTML =
      '<div class="card">' +
        '<div class="kpis">' +
          '<div class="kpi"><div class="n">' + num(c.inactive) + '</div><div class="l">Inactive (activatable)</div></div>' +
          '<div class="kpi"><div class="n">' + num(c.blocked) + '</div><div class="l">Blocked (terminal)</div></div>' +
        '</div>' +
        '<div class="bhead" style="margin-top:10px"><h2 style="font-size:15px">All set-aside volunteers</h2>' +
          (hasInactive ? '<button class="btn" id="bulkBtn">Activate selected</button>' : '') + '</div>' +
        '<div id="actResult"></div>' +
        '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Region</th><th>Ceremony JK</th><th>Area</th><th>Status</th><th>Reason</th><th>Action</th></tr></thead><tbody>' +
          people.map(personRow).join("") +
        '</tbody></table></div>' +
      '</div>';
    Array.prototype.forEach.call(document.querySelectorAll(".act"), function (b) {
      b.addEventListener("click", function () { activate([b.getAttribute("data-id")]); });
    });
    if (EL("bulkBtn")) EL("bulkBtn").addEventListener("click", function () {
      var ids = Array.prototype.map.call(document.querySelectorAll(".sel:checked"), function (c) { return c.getAttribute("data-id"); });
      if (!ids.length) { banner("Select at least one inactive volunteer to activate.", true); return; }
      activate(ids);
    });
  }

  function activate(ids) {
    if (!ids || !ids.length) return;
    if (!window.confirm("Activate " + num(ids.length) + " volunteer(s)?\n\nThey return to the normal flow (un-accepted, so they re-enter allocation and calling).")) return;
    if (busy) return; busy = true; clearBanner();
    EL("actResult").innerHTML = '<div class="small" style="margin-top:10px">Activating\u2026</div>';
    fetch("/api/inactive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_ids: ids }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { EL("actResult").innerHTML = ""; banner(esc(d.error), true); return; }
        var bits = ["Activated <b>" + num(d.activated) + "</b>."];
        if (d.skippedBlocked) bits.push(num(d.skippedBlocked) + " were blocked (terminal) and left as-is.");
        if (d.notInactive) bits.push(num(d.notInactive) + " were not inactive.");
        EL("actResult").innerHTML = '<div class="good" style="margin-top:12px">' + bits.join(" ") + "</div>";
        setTimeout(load, 500);
      }).catch(function () {
        EL("actResult").innerHTML = "";
        banner("The activate request failed \u2014 refresh before retrying.", true);
      }).then(function () { busy = false; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();
    EL("refreshBtn").addEventListener("click", load);
  });
})();
