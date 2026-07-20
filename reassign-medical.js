// Reassign Medical Services (event wrap-up). Shows the proposed split across the three target areas and
// commits it. All planning is server-side (/api/reassignmedical, shared/reassign); this is review + button.
(function () {
  var VIEW = null, busy = false;
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }

  function regionTable(byRegion, targets) {
    var regions = Object.keys(byRegion || {});
    if (!regions.length) return "";
    var head = '<tr><th>Region</th>' + targets.map(function (t) { return '<th class="n">' + esc(t) + '</th>'; }).join("") + '<th class="n">Total</th></tr>';
    var body = regions.map(function (r) {
      var c = byRegion[r].counts || {};
      return '<tr><td>' + esc(r) + '</td>' + targets.map(function (t) { return '<td class="n">' + num(c[t]) + '</td>'; }).join("") + '<td class="n">' + num(byRegion[r].total) + '</td></tr>';
    }).join("");
    return '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }
  function sampleTable(sample) {
    if (!sample || !sample.length) return "";
    return '<details><summary>Sample of who goes where (' + sample.length + ')</summary><div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Region</th><th>New area</th><th>Why</th></tr></thead><tbody>' +
      sample.map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.region) + '</td><td>' + esc(s.to) + '</td><td>' + (s.reason === "interest" ? "Area of interest" : "Balanced") + '</td></tr>'; }).join("") +
      '</tbody></table></div></details>';
  }

  function load() {
    clearBanner();
    fetch("/api/reassignmedical").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { EL("results").innerHTML = ""; banner(esc(d.error), true); return; }
      VIEW = d; render(d);
    }).catch(function () { EL("results").innerHTML = ""; banner("Couldn\u2019t load the preview.", true); });
  }

  function render(d) {
    var targets = d.targets || [], counts = d.counts || {}, reason = d.byReason || {};
    EL("scope").textContent = "Regions in scope: " + Object.keys(d.byRegion || {}).join(", ");
    if (!d.total) {
      EL("results").innerHTML = '<div class="card"><div class="good" style="margin:0">No one is in Medical Services. Nothing to reassign \u2014 you can go ahead with the mass-accept.</div></div>';
      return;
    }
    var kpis = targets.map(function (t) {
      return '<div class="kpi go"><div class="n">' + num(counts[t]) + '</div><div class="l">' + esc(t) + '</div></div>';
    }).join("");

    EL("results").innerHTML =
      '<div class="card">' +
        '<div class="bhead"><h2>' + num(d.total) + ' in Medical Services \u2192 reassigned</h2>' +
          '<button class="btn commit" id="commitBtn">Reassign ' + num(d.total) + ' now</button></div>' +
        '<div class="small">' + num(reason.interest) + ' placed into an area they were interested in &middot; ' + num(reason.balanced) + ' placed to keep the split even.</div>' +
        '<div class="kpis" style="margin-top:12px">' + kpis + '</div>' +
        '<div id="commitResult"></div>' +
        '<div style="margin-top:16px"><h2 style="font-size:15px">Split by region</h2>' + regionTable(d.byRegion, targets) + '</div>' +
        sampleTable(d.sample) +
      '</div>';
    if (EL("commitBtn")) EL("commitBtn").addEventListener("click", commit);
  }

  function commit() {
    if (!VIEW || !VIEW.total) return;
    if (!window.confirm("Reassign " + num(VIEW.total) + " people out of Medical Services into the three areas?\n\nTheir area is changed now. Run the mass-accept afterward so they're accepted into the new area.")) return;
    if (busy) return; busy = true; EL("commitBtn").disabled = true; clearBanner();
    EL("commitResult").innerHTML = '<div class="small" style="margin-top:10px">Reassigning\u2026</div>';
    fetch("/api/reassignmedical", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { EL("commitResult").innerHTML = ""; banner(esc(d.error), true); EL("commitBtn").disabled = false; return; }
        EL("commitResult").innerHTML = '<div class="good" style="margin-top:12px">Reassigned <b>' + num(d.movedCount) + '</b> people out of Medical Services. Now run the <b>Mass accept</b> so they\u2019re accepted into their new areas.</div>';
        setTimeout(load, 400);
      }).catch(function () {
        EL("commitResult").innerHTML = "";
        banner("The reassign request failed \u2014 some may have moved. Refresh the preview before retrying.", true);
        EL("commitBtn").disabled = false;
      }).then(function () { busy = false; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();
    EL("refreshBtn").addEventListener("click", load);
  });
})();
