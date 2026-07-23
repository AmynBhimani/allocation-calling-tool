// Mass accept (event wrap-up). Loads the dry-run, shows the buckets, and commits ONLY the accept bucket.
// All classification is server-side (/api/massaccept, shared/wrapup); this screen is the review + the button.
(function () {
  var VIEW = null, busy = false;
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }

  function areaTable(byArea) {
    var keys = Object.keys(byArea || {}).sort(function (a, b) { return byArea[b] - byArea[a] || a.localeCompare(b); });
    if (!keys.length) return "";
    return '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Area</th><th class="n">People</th></tr></thead><tbody>' +
      keys.map(function (a) { return '<tr><td>' + esc(a) + '</td><td class="n">' + num(byArea[a]) + '</td></tr>'; }).join("") +
      '</tbody></table></div>';
  }
  function sampleList(sample) {
    if (!sample || !sample.length) return "";
    return '<details><summary>Sample (' + sample.length + ')</summary><div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Area</th><th>Region</th><th>Call status</th></tr></thead><tbody>' +
      sample.map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.area) + '</td><td>' + esc(s.region) + '</td><td>' + esc(s.call_outcome || "\u2014") + '</td></tr>'; }).join("") +
      '</tbody></table></div></details>';
  }

  function currentFilter() {
    return { area: EL("areaFilter") ? EL("areaFilter").value : "", region: EL("regionFilter") ? EL("regionFilter").value : "" };
  }
  function fillFilterOptions(d) {
    var af = EL("areaFilter");
    if (af && !af.dataset.filled && Array.isArray(d.areas)) {
      d.areas.forEach(function (a) { var o = document.createElement("option"); o.value = a; o.textContent = a; af.appendChild(o); });
      af.dataset.filled = "1";
    }
    var rf = EL("regionFilter");
    if (rf && !rf.dataset.filled && Array.isArray(d.regions)) {
      d.regions.forEach(function (r) { var o = document.createElement("option"); o.value = r; o.textContent = r; rf.appendChild(o); });
      rf.dataset.filled = "1";
    }
  }
  function filterLabel() {
    var f = currentFilter(), bits = [];
    if (f.area) bits.push(f.area);
    if (f.region) bits.push(f.region);
    return bits.length ? " (" + bits.join(", ") + ")" : "";
  }

  function load() {
    clearBanner();
    var f = currentFilter();
    var qs = [];
    if (f.area) qs.push("area=" + encodeURIComponent(f.area));
    if (f.region) qs.push("region=" + encodeURIComponent(f.region));
    fetch("/api/massaccept" + (qs.length ? "?" + qs.join("&") : "")).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { EL("results").innerHTML = ""; banner(esc(d.error), true); return; }
      VIEW = d; fillFilterOptions(d); render(d);
    }).catch(function () { EL("results").innerHTML = ""; banner("Couldn\u2019t load the preview.", true); });
  }

  function render(d) {
    var b = d.buckets || {}, acc = b.accept || {}, un = b.unreached || {}, la = b.leaveAlone || {}, sk = d.skipped || {};
    var flt = (d.filter && (d.filter.area || d.filter.region)) ? filterLabel() : "";
    EL("scope").textContent = "Regions in scope: " + ((d.scope || []).join(", ") || "none") + (flt ? " · filtered" + flt : "");

    var html =
      '<div class="card">' +
        '<div class="kpis">' +
          '<div class="kpi go"><div class="n">' + num(acc.total) + '</div><div class="l">Accept</div></div>' +
          '<div class="kpi flag"><div class="n">' + num(un.total) + '</div><div class="l">Unreached &rarr; No-Response email</div></div>' +
          '<div class="kpi"><div class="n">' + num(la.total) + '</div><div class="l">Withdrew / duplicate &mdash; left alone</div></div>' +
        '</div>' +
        '<div class="small" style="margin-top:6px">Skipped: ' + num(sk.alreadyAccepted) + ' already accepted &middot; ' +
          num(sk.inReconciliation) + ' in reconciliation &middot; ' + num(sk.noArea) + ' no area yet &middot; ' + num(sk.leadership) + ' leadership.</div>' +

        '<div class="bhead" style="margin-top:16px"><h2>Accept bucket</h2>' +
          '<button class="btn commit" id="commitBtn"' + (acc.total ? '' : ' disabled') + '>Accept ' + num(acc.total) + ' into their areas' + esc(flt) + '</button></div>' +
        '<div class="small">These had an area but were never accepted, and no caller logged a "no" for them. Accepting matches a caller marking them Accepted.</div>' +
        areaTable(acc.byArea) + sampleList(acc.sample) +
        '<div id="commitResult"></div>' +

        '<div style="margin-top:20px"><h2>Unreached &mdash; not accepted here</h2>' +
        '<div class="small">Caller logged No answer, Emailed, or Thinking. Left un-accepted; these are who the <b>No-Response email</b> goes to. Sending that email is a separate step.</div>' +
        areaTable(un.byArea) + sampleList(un.sample) + '</div>' +

        '<div style="margin-top:20px"><h2>Left alone</h2>' +
        '<div class="small">Caller marked them Withdrew or Duplicate &mdash; a definitive no. Not accepted, not emailed.</div>' +
        areaTable(la.byArea) + sampleList(la.sample) + '</div>' +
      '</div>';

    EL("results").innerHTML = html;
    if (EL("commitBtn")) EL("commitBtn").addEventListener("click", commit);
  }

  function commit() {
    var acc = (VIEW && VIEW.buckets && VIEW.buckets.accept) || {};
    if (!acc.total) return;
    var f = currentFilter();
    var scopeMsg = filterLabel() ? (" in" + filterLabel()) : " into their assigned areas";
    if (!window.confirm("Accept " + num(acc.total) + " volunteers" + scopeMsg + "?\n\nThis marks them Accepted with no call. You can reopen individuals afterward from the Accepted screen. Unreached and withdrawn people are not touched.")) return;
    if (busy) return; busy = true; EL("commitBtn").disabled = true; clearBanner();
    EL("commitResult").innerHTML = '<div class="small" style="margin-top:10px">Accepting\u2026 this can take a moment.</div>';
    fetch("/api/massaccept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ area: f.area || undefined, region: f.region || undefined }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { EL("commitResult").innerHTML = ""; banner(esc(d.error), true); EL("commitBtn").disabled = false; return; }
        var regions = Object.keys(d.byRegion || {}).map(function (r) { return r + ": " + num(d.byRegion[r]); }).join(" \u00b7 ");
        EL("commitResult").innerHTML = '<div class="good" style="margin-top:12px">Accepted <b>' + num(d.acceptedCount) + '</b> volunteer' + (d.acceptedCount === 1 ? "" : "s") +
          (regions ? ' (' + esc(regions) + ')' : '') + '. They now count as accepted everywhere and are ready for the acceptance email.</div>';
        // refresh so the accept bucket reflects what just happened (should drop to ~0)
        setTimeout(load, 400);
      }).catch(function () {
        EL("commitResult").innerHTML = "";
        banner("The accept request failed \u2014 some may have gone through. Refresh the preview before retrying.", true);
        EL("commitBtn").disabled = false;
      }).then(function () { busy = false; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();
    EL("refreshBtn").addEventListener("click", load);
    if (EL("areaFilter")) EL("areaFilter").addEventListener("change", load);
    if (EL("regionFilter")) EL("regionFilter").addEventListener("change", load);
  });
})();
