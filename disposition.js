// Apply Dispositions — paste a reviewed {user_id, disposition} list, preview (server dry-run), then commit.
// All logic is server-side (/api/disposition, shared/disposition); this parses the paste and shows results.
(function () {
  var ITEMS = null, busy = false;
  var KNOWN = { block: 1, inactivate: 1, needs_bi: 1 };
  var LABEL = { block: "Block (terminal)", inactivate: "Inactivate (reversible)", needs_bi: "Needs a BI account" };
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }

  // Lenient parse: first token is the id; the disposition is the first recognized keyword on the line, so
  // extra columns (name, region) are tolerated. Header rows are skipped.
  function parseItems() {
    var lines = (EL("input").value || "").split(/\r?\n/);
    var items = [], bad = 0;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim(); if (!ln) continue;
      var parts = ln.split(/[,\t\s]+/).filter(Boolean);
      if (!parts.length) continue;
      var head = parts[0].toLowerCase().replace(/\s/g, "");
      if (head === "userid" || head === "user_id" || head === "id") continue;   // header line
      var uid = parts[0], disp = "";
      for (var j = 1; j < parts.length; j++) { var t = parts[j].toLowerCase(); if (KNOWN[t]) { disp = t; break; } }
      if (!disp) { bad++; continue; }
      items.push({ user_id: uid, disposition: disp });
    }
    return { items: items, bad: bad };
  }

  function post(commit) {
    return fetch("/api/disposition", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: ITEMS, commit: commit }) }).then(function (r) { return r.json(); });
  }

  function preview() {
    clearBanner();
    var p = parseItems();
    if (!p.items.length) { banner("No valid <code>user_id, disposition</code> lines found. Each line needs an id and one of block / inactivate / needs_bi.", true); return; }
    ITEMS = p.items;
    EL("parsed").textContent = num(p.items.length) + " line(s) parsed" + (p.bad ? "  \u2022  " + num(p.bad) + " skipped (no disposition)" : "");
    EL("results").innerHTML = '<div class="card"><div class="small">Previewing\u2026</div></div>';
    post(false).then(function (d) {
      if (d.error) { EL("results").innerHTML = ""; banner(esc(d.error), true); return; }
      renderPreview(d);
    }).catch(function () { EL("results").innerHTML = ""; banner("Couldn\u2019t reach the server for the preview.", true); });
  }

  function kindRow(k, x) {
    var toApply = Math.max(0, (x.count || 0) - (x.already || 0));
    return '<tr><td>' + esc(LABEL[k]) + '</td>' +
      '<td class="n"><b>' + num(toApply) + '</b></td>' +
      '<td class="n">' + num(x.already) + '</td>' +
      '<td class="n">' + num(x.accepted) + '</td>' +
      '<td class="n">' + num(x.onLineup) + '</td>' +
      '<td class="n">' + num(x.holdsDuty) + '</td></tr>';
  }

  function sampleBlock(k, x) {
    if (!x.sample || !x.sample.length) return "";
    return '<details><summary>' + esc(LABEL[k]) + ' \u2014 sample (' + x.sample.length + ')</summary>' +
      '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Region</th><th>Area</th><th>Accepted?</th><th>On lineup?</th></tr></thead><tbody>' +
      x.sample.map(function (s) { return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.region) + '</td><td>' + esc(s.area || "\u2014") + '</td><td>' + (s.accepted ? "Yes" : "\u2014") + '</td><td>' + (s.onLineup ? "Yes" : "\u2014") + '</td></tr>'; }).join("") +
      '</tbody></table></div></details>';
  }

  function renderPreview(d) {
    var K = d.kinds || {};
    var totalApply = ["block", "inactivate", "needs_bi"].reduce(function (n, k) { return n + Math.max(0, ((K[k] || {}).count || 0) - ((K[k] || {}).already || 0)); }, 0);
    var flags = "";
    if (d.notFound) flags += '<div class="warnbox">' + num(d.notFound) + ' id(s) were not found in your regions and will be skipped.' + (d.notFoundSample && d.notFoundSample.length ? ' <span class="small">e.g. ' + esc(d.notFoundSample.slice(0, 6).join(", ")) + '</span>' : '') + '</div>';
    if (d.invalid) flags += '<div class="warnbox">' + num(d.invalid) + ' row(s) had an unrecognized disposition and were ignored.</div>';

    EL("results").innerHTML =
      '<div class="card">' +
        '<div class="bhead"><h2>Preview</h2>' +
          '<button class="btn commit" id="commitBtn"' + (totalApply ? "" : " disabled") + '>Apply to ' + num(totalApply) + ' volunteer(s)</button></div>' +
        '<div class="small" style="margin:6px 0 12px">' + num(d.requested) + ' requested \u2022 ' + num(d.resolvable) + ' resolved in your regions</div>' +
        flags +
        '<div class="scrollx"><table class="matrix"><thead><tr><th>Disposition</th><th class="n">To apply</th><th class="n">Already done</th><th class="n">Currently accepted</th><th class="n">On a lineup</th><th class="n">Holds a duty</th></tr></thead><tbody>' +
          kindRow("block", K.block || {}) + kindRow("inactivate", K.inactivate || {}) + kindRow("needs_bi", K.needs_bi || {}) +
        '</tbody></table></div>' +
        '<div class="small" style="margin-top:8px">Block &amp; Inactivate <b>un-accept</b> people and clear their duty/lineup. Needs-BI keeps them accepted but <b>pulls them off any lineup</b>.</div>' +
        '<div id="commitResult"></div>' +
        sampleBlock("block", K.block || {}) + sampleBlock("inactivate", K.inactivate || {}) + sampleBlock("needs_bi", K.needs_bi || {}) +
      '</div>';
    if (EL("commitBtn")) EL("commitBtn").addEventListener("click", function () { commit(totalApply); });
  }

  function commit(totalApply) {
    if (!ITEMS || !totalApply) return;
    if (!window.confirm("Apply dispositions to " + num(totalApply) + " volunteer(s)?\n\nBlock and Inactivate will un-accept them and clear their duty and lineup. Needs-BI keeps them accepted but pulls them off any lineup. This is reversible for Inactivate (Activate screen) but not for Block.")) return;
    if (busy) return; busy = true; EL("commitBtn").disabled = true; clearBanner();
    EL("commitResult").innerHTML = '<div class="small" style="margin-top:10px">Applying\u2026</div>';
    post(true).then(function (d) {
      if (d.error) { EL("commitResult").innerHTML = ""; banner(esc(d.error), true); EL("commitBtn").disabled = false; return; }
      var a = d.applied || {}, al = d.already || {};
      var msg = 'Applied \u2014 blocked <b>' + num(a.block) + '</b>, inactivated <b>' + num(a.inactivate) + '</b>, needs-BI <b>' + num(a.needs_bi) + '</b>.' +
        ((al.block || al.inactivate || al.needs_bi) ? ' <span class="small">(' + num((al.block || 0) + (al.inactivate || 0) + (al.needs_bi || 0)) + ' were already applied and left as-is.)</span>' : '');
      if (d.failed) {
        EL("commitResult").innerHTML = '<div class="warnbox" style="margin-top:12px">' + msg + '<br><b>' + num(d.failed) + '</b> could not be written this pass (write contention). They are safe to retry \u2014 just <b>Preview</b> and <b>Apply</b> again; anything already done is skipped.</div>';
      } else {
        EL("commitResult").innerHTML = '<div class="good" style="margin-top:12px">' + msg + '</div>';
      }
    }).catch(function () {
      EL("commitResult").innerHTML = "";
      banner("The apply request failed \u2014 some may have been applied. Preview again before retrying.", true);
      EL("commitBtn").disabled = false;
    }).then(function () { busy = false; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    EL("previewBtn").addEventListener("click", preview);
  });
})();
