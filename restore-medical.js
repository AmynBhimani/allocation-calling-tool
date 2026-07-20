// Restore Medical Services — reverse the reassignment. All planning is server-side (/api/restoremedical,
// shared/reassign planRestore/applyRestore); this is review + a commit button.
(function () {
  var VIEW = null, busy = false;
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }

  function areaTable(byArea) {
    var areas = Object.keys(byArea || {});
    if (!areas.length) return "";
    var body = areas.map(function (a) { return '<tr><td>' + esc(a) + '</td><td class="n">' + num(byArea[a]) + '</td></tr>'; }).join("");
    return '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Currently in</th><th class="n">To restore</th></tr></thead><tbody>' + body + '</tbody></table></div>';
  }
  function sampleTable(sample) {
    if (!sample || !sample.length) return "";
    return '<details open><summary>Who will be restored (' + sample.length + ' shown)</summary><div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Region</th><th>Currently in</th><th>Accepted?</th><th>Duty</th></tr></thead><tbody>' +
      sample.map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.region) + '</td><td>' + esc(s.currentArea) + '</td><td>' + (s.accepted ? "Yes" : "\u2014") + '</td><td>' + esc(s.duty || "\u2014") + '</td></tr>'; }).join("") +
      '</tbody></table></div></details>';
  }

  function load() {
    clearBanner();
    fetch("/api/restoremedical").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { EL("results").innerHTML = ""; banner(esc(d.error), true); return; }
      VIEW = d; render(d);
    }).catch(function () { EL("results").innerHTML = ""; banner("Couldn\u2019t load the preview.", true); });
  }

  function render(d) {
    EL("scope").textContent = "Regions in scope: " + Object.keys(d.byRegion || {}).join(", ");
    if (!d.total) {
      EL("results").innerHTML = '<div class="card"><div class="good" style="margin:0">No reassigned Medical Services volunteers to restore \u2014 either it wasn\u2019t run, or they\u2019re already back.</div></div>';
      return;
    }
    EL("results").innerHTML =
      '<div class="card">' +
        '<div class="bhead"><h2>' + num(d.total) + ' to restore to Medical Services</h2>' +
          '<button class="btn commit" id="commitBtn">Restore ' + num(d.total) + ' now</button></div>' +
        '<div class="kpis" style="margin-top:12px">' +
          '<div class="kpi go"><div class="n">' + num(d.total) + '</div><div class="l">Will return to Medical Services</div></div>' +
          '<div class="kpi' + (d.accepted ? ' flag' : '') + '"><div class="n">' + num(d.accepted) + '</div><div class="l">Of those, had already accepted</div></div>' +
        '</div>' +
        '<div id="commitResult"></div>' +
        '<div style="margin-top:16px"><h2 style="font-size:15px">Where they are now</h2>' + areaTable(d.byArea) + '</div>' +
        sampleTable(d.sample) +
      '</div>';
    if (EL("commitBtn")) EL("commitBtn").addEventListener("click", commit);
  }

  function commit() {
    if (!VIEW || !VIEW.total) return;
    if (!window.confirm("Restore " + num(VIEW.total) + " people to Medical Services?\n\nThis reverses the reassignment and brings back their accepted status, duty, and confirmation intact.")) return;
    if (busy) return; busy = true; EL("commitBtn").disabled = true; clearBanner();
    EL("commitResult").innerHTML = '<div class="small" style="margin-top:10px">Restoring\u2026</div>';
    fetch("/api/restoremedical", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { EL("commitResult").innerHTML = ""; banner(esc(d.error), true); EL("commitBtn").disabled = false; return; }
        EL("commitResult").innerHTML = '<div class="good" style="margin-top:12px">Restored <b>' + num(d.restored) + '</b> people to Medical Services. Their duties and accepted status came back with them.</div>';
        setTimeout(load, 400);
      }).catch(function () {
        EL("commitResult").innerHTML = "";
        banner("The restore request failed \u2014 some may have been restored. Refresh the preview before retrying.", true);
        EL("commitBtn").disabled = false;
      }).then(function () { busy = false; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();
    EL("refreshBtn").addEventListener("click", load);
  });
})();
