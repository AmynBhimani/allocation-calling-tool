// No-Response email panel. Previews the unreached cohort and the message, sends a test, then sends in
// batches of up to 500. Server selects (unreached bucket), renders, and stamps "Sent No Response Email".
(function () {
  var VIEW = null, busy = false;
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }

  function load() {
    clearBanner();
    EL("results").innerHTML = '<div class="card"><div class="small">Loading preview\u2026</div></div>';
    fetch("/api/noresponseemail").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { EL("results").innerHTML = ""; banner(esc(d.error), true); return; }
      VIEW = d; render(d);
    }).catch(function () { EL("results").innerHTML = ""; banner("Couldn\u2019t load the preview.", true); });
  }

  function render(d) {
    var c = d.counts || {}, elig = d.eligible || [], noem = d.noEmail || [];
    var rows = elig.map(function (e) { return '<tr><td>' + esc(e.name) + '</td><td>' + esc(e.region) + '</td><td>' + esc(e.email) + '</td></tr>'; }).join("");
    var noRows = noem.map(function (e) { return '<tr><td>' + esc(e.name) + '</td><td>' + esc(e.region) + '</td></tr>'; }).join("");

    EL("results").innerHTML =
      '<div class="card">' +
        '<div class="kpis">' +
          '<div class="kpi go"><div class="n">' + num(c.eligible) + '</div><div class="l">Ready to email</div></div>' +
          '<div class="kpi' + (c.noEmail ? ' flag' : '') + '"><div class="n">' + num(c.noEmail) + '</div><div class="l">Unreached, no email</div></div>' +
          '<div class="kpi"><div class="n">' + num(c.alreadySent) + '</div><div class="l">Already emailed</div></div>' +
        '</div>' +
        (d.capped ? '<div class="small">Showing the first ' + num(elig.length) + ' recipients; the count above is exact.</div>' : '') +

        '<div class="sep"></div>' +
        '<div class="row">' +
          '<div class="field"><label>Send a test to</label><input id="testTo" type="email" placeholder="you@example.com"></div>' +
          '<button class="btn ghost2" id="testBtn">Send test</button>' +
          '<button class="btn commit" id="sendBtn"' + (c.eligible ? '' : ' disabled') + '>Send to ' + num(c.eligible) + ' now</button>' +
        '</div>' +
        '<div class="small" style="margin-top:8px">Sends automatically in batches of 500 until everyone is done \u2014 keep the tab open. Safe to stop and resume.</div>' +
        '<div id="sendResult"></div>' +

        (elig.length ?
          '<details><summary>See the ' + num(elig.length) + ' recipients</summary>' +
          '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Region</th><th>Email</th></tr></thead><tbody>' +
          rows + '</tbody></table></div></details>' : '') +
        (noem.length ?
          '<details><summary>' + num(noem.length) + ' unreached with no email</summary>' +
          '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Region</th></tr></thead><tbody>' +
          noRows + '</tbody></table></div></details>' : '') +
        '<details open><summary>Preview the email</summary>' +
        '<iframe class="previewframe" id="preview" sandbox title="Email preview"></iframe></details>' +
      '</div>';

    var f = EL("preview"); if (f && d.sample) f.srcdoc = d.sample.html;
    EL("testBtn").addEventListener("click", sendTest);
    EL("sendBtn").addEventListener("click", sendReal);
  }

  function sendTest() {
    var to = (EL("testTo").value || "").trim();
    if (!to) { banner("Enter a test address first.", true); return; }
    if (busy) return; busy = true; EL("testBtn").disabled = true; clearBanner();
    fetch("/api/noresponseemail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "test", testTo: to }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) banner(esc(d.error), true);
        else banner('Test sent to <b>' + esc(d.testSentTo) + '</b>.', false);
      }).catch(function () { banner("Couldn\u2019t send the test.", true); })
      .then(function () { busy = false; EL("testBtn").disabled = false; });
  }

  function progressHtml(sent, total, subtitle) {
    var pct = total ? Math.min(100, Math.round(sent / total * 100)) : (sent ? 100 : 0);
    return '<div style="margin-top:12px">' +
      '<div style="height:10px;background:#eef1f4;border:1px solid var(--line);border-radius:999px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:var(--teal)"></div></div>' +
      '<div class="small" style="margin-top:6px">Sent <b>' + num(sent) + '</b> of <b>' + num(total) + '</b>' + (subtitle ? ' \u2014 ' + subtitle : '') + '</div></div>';
  }
  function failuresTable(list) {
    return '<details><summary>See the ' + num(list.length) + ' that couldn\u2019t be sent</summary><div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>User ID</th><th>Error</th></tr></thead><tbody>' +
      list.map(function (f) { return '<tr><td>' + esc(f.name || "") + '</td><td>' + esc(f.user_id) + '</td><td>' + esc(f.error) + '</td></tr>'; }).join("") +
      '</tbody></table></div></details>';
  }

  // Auto-advance: fire batches back-to-back until the cohort is clear. Backend unchanged (up to 500 per
  // request, stamped, resumable); the browser drives the loop. Sequential, so no double-sends. Stops on
  // completion, zero-progress (persistent failures), a hard round cap, or a dropped connection.
  function sendReal() {
    var c = (VIEW && VIEW.counts) || {};
    var total = c.eligible || 0;
    if (!total) return;
    if (!window.confirm("Email " + num(total) + " unreached volunteer" + (total === 1 ? "" : "s") + "?\n\nThis sends automatically in batches of 500, marking each \u201CSent No Response Email\u201D. Keep this tab open until it finishes.")) return;
    if (busy) return; busy = true; EL("sendBtn").disabled = true; EL("testBtn").disabled = true; clearBanner();

    var sentTotal = 0, rounds = 0, maxRounds = Math.ceil(total / 500) + 5, lastFailures = [], stampWarn = null;
    EL("sendResult").innerHTML = progressHtml(0, total, "keep this tab open\u2026");

    function finish(kind, detail) {
      var remaining = Math.max(0, total - sentTotal), msg;
      if (kind === "done") {
        msg = '<div class="good" style="margin-top:12px">Done \u2014 sent <b>' + num(sentTotal) + '</b> email' + (sentTotal === 1 ? "" : "s") + '. Everyone unreached has now been emailed and marked.</div>';
      } else if (kind === "error") {
        msg = '<div class="warn" style="margin-top:12px">Sent <b>' + num(sentTotal) + '</b> of ' + num(total) + ', then hit an error: ' + (detail || "") + '. Nobody was emailed twice \u2014 <b>Preview again</b> to send the rest.</div>';
      } else {
        msg = '<div class="warn" style="margin-top:12px">Sent <b>' + num(sentTotal) + '</b> of ' + num(total) + '. <b>' + num(remaining) + '</b> couldn\u2019t be sent' + (kind === "stalled" ? " (they failed on retry)" : "") + '. They\u2019re not marked, so <b>Preview again</b> to retry just them.</div>' + (lastFailures.length ? failuresTable(lastFailures) : "");
      }
      if (stampWarn) msg += '<div class="warn">Some were sent but couldn\u2019t be marked \u2014 <b>Preview again before sending</b> so they aren\u2019t emailed twice. (' + esc(JSON.stringify(stampWarn)) + ')</div>';
      EL("sendResult").innerHTML = progressHtml(sentTotal, total, "") + msg;
      busy = false; EL("sendBtn").disabled = false; EL("testBtn").disabled = false;
    }

    function step() {
      rounds++;
      fetch("/api/noresponseemail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "send" }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { finish("error", esc(d.error)); return; }
          sentTotal += (d.sent || 0);
          if (d.failures && d.failures.length) lastFailures = d.failures; else if (d.sent) lastFailures = [];
          if (d.stampWriteFailed) stampWarn = d.stampWriteFailed;
          EL("sendResult").innerHTML = progressHtml(sentTotal, total, "keep this tab open\u2026");
          if (d.remaining === 0) { finish("done"); return; }
          if (!d.sent) { finish("stalled"); return; }
          if (rounds >= maxRounds) { finish("capped"); return; }
          step();
        })
        .catch(function () { finish("error", "the connection dropped"); });
    }
    step();
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();
    EL("refreshBtn").addEventListener("click", load);
  });
})();
