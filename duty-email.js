// Duty confirmation emails — the admin panel. Pick a session, preview exactly who would be emailed and
// what the message looks like, send a test to yourself, then send in batches of up to 500. All the real
// decisions (who is eligible, what the email says, stamping notified_at so no one is emailed twice) live
// on the server in /api/dutyemail; this screen is just the controls and the readout.
(function () {
  var SESSIONS = [], VIEW = null, busy = false;
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }
  function session() { return EL("session").value || ""; }
  function sessionName() { var s = SESSIONS.filter(function (x) { return x.id === session(); })[0]; return s ? s.name : ""; }

  // All-sessions duty progress tally (sent vs. remaining across every session), shown in the header.
  function loadSummary() {
    fetch("/api/dutyemail?summary=1").then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.summary) return;
      var s = d.summary, emailable = s.sent + s.remaining, pct = emailable ? Math.round(s.sent / emailable * 100) : 0;
      EL("summary").hidden = false;
      EL("summary").innerHTML =
        '<div class="bar"><div style="width:' + pct + '%"></div></div>' +
        '<b>' + num(s.sent) + '</b> duty emails sent \u00b7 <b>' + num(s.remaining) + '</b> still to send' +
        (s.noEmail ? ' \u00b7 ' + num(s.noEmail) + ' no email' : '') +
        ' <span class="mute">(' + pct + '% across all sessions)</span>';
    }).catch(function () {});
  }

  function load() {
    return fetch("/api/dutyemail").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { banner(esc(d.error), true); return; }
      SESSIONS = (d && d.sessions) || [];
      EL("session").innerHTML = SESSIONS.length
        ? SESSIONS.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>"; }).join("")
        : '<option value="">(no sessions)</option>';
      EL("previewBtn").disabled = !SESSIONS.length;
      EL("downloadBtn").disabled = !SESSIONS.length;
    }).catch(function () { banner("Couldn\u2019t load sessions.", true); });
  }

  function preview() {
    if (!session()) return;
    clearBanner();
    EL("results").innerHTML = '<div class="card"><div class="small">Loading\u2026</div></div>';
    fetch("/api/dutyemail?session=" + encodeURIComponent(session()))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { EL("results").innerHTML = ""; banner(esc(d.error), true); return; }
        VIEW = d; renderPreview(d);
      }).catch(function () { EL("results").innerHTML = ""; banner("Couldn\u2019t load the preview.", true); });
  }

  function renderPreview(d) {
    var c = d.counts || {}, elig = d.eligible || [], noem = d.noEmail || [];
    var rows = elig.map(function (e) {
      return '<tr><td>' + esc(e.name) + (e.isLead ? ' <span class="small">(lead)</span>' : '') + '</td><td>' + esc(e.area) +
        '</td><td>' + esc(e.dutyName) + '</td><td>' + esc(e.checkIn) + '</td><td>' + esc(e.region) + '</td><td>' + esc(e.email) + '</td></tr>';
    }).join("");
    var noRows = noem.map(function (e) {
      return '<tr><td>' + esc(e.name) + '</td><td>' + esc(e.area) + '</td><td>' + esc(e.dutyName) + '</td><td>' + esc(e.region) + '</td></tr>';
    }).join("");

    EL("results").innerHTML =
      '<div class="card">' +
        '<h2>' + esc(d.session.name) + '</h2>' +
        '<div class="kpis">' +
          '<div class="kpi go"><div class="n">' + num(c.eligible) + '</div><div class="l">Ready to email</div></div>' +
          '<div class="kpi' + (c.noEmail ? ' flag' : '') + '"><div class="n">' + num(c.noEmail) + '</div><div class="l">On lineup, no email</div></div>' +
          '<div class="kpi"><div class="n">' + num(c.alreadySent) + '</div><div class="l">Already emailed</div></div>' +
          '<div class="kpi"><div class="n">' + num(c.onLineup) + '</div><div class="l">On the lineup</div></div>' +
        '</div>' +
        (d.capped ? '<div class="small">Showing the first ' + num(elig.length) + ' ready recipients; the count above is exact.</div>' : '') +
        '<div class="sep"></div>' +
        '<div class="row">' +
          '<div class="field"><label>Send a test to</label><input id="testTo" type="email" placeholder="you@example.com"></div>' +
          '<button class="btn ghost2" id="testBtn">Send test</button>' +
          '<button class="btn commit" id="sendBtn"' + (c.eligible ? '' : ' disabled') + '>Send to ' + num(c.eligible) + ' now</button>' +
        '</div>' +
        '<div class="small" style="margin-top:8px">Sends up to 500 per click. If more remain, click <b>Send</b> again \u2014 anyone already emailed is skipped.</div>' +
        '<div id="sendResult"></div>' +
        (elig.length ?
          '<details><summary>See the ' + num(elig.length) + ' ready recipients</summary>' +
          '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Area</th><th>Duty</th><th>Check-in</th><th>Region</th><th>Email</th></tr></thead><tbody>' +
          rows + '</tbody></table></div></details>' : '') +
        (noem.length ?
          '<details><summary>' + num(noem.length) + ' on the lineup with no email \u2014 phone them</summary>' +
          '<div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>Area</th><th>Duty</th><th>Region</th></tr></thead><tbody>' +
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
    fetch("/api/dutyemail", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session(), mode: "test", testTo: to }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) banner(esc(d.error), true);
        else banner('Test sent to <b>' + esc(d.testSentTo) + '</b>' + (d.usedRealRecipient ? " (with a real recipient\u2019s details)." : " (sample details \u2014 no eligible recipient yet)."), false);
      }).catch(function () { banner("Couldn\u2019t send the test.", true); })
      .then(function () { busy = false; EL("testBtn").disabled = false; });
  }

  function sendReal() {
    var c = (VIEW && VIEW.counts) || {};
    if (!c.eligible) return;
    if (!window.confirm("Email " + num(c.eligible) + " volunteer" + (c.eligible === 1 ? "" : "s") + " for " + sessionName() + "?\n\nUp to 500 will be sent now.")) return;
    if (busy) return; busy = true; EL("sendBtn").disabled = true; clearBanner();
    EL("sendResult").innerHTML = '<div class="small" style="margin-top:10px">Sending\u2026 this can take up to a minute; don\u2019t close the tab.</div>';
    fetch("/api/dutyemail", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session(), mode: "send" }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { EL("sendResult").innerHTML = ""; banner(esc(d.error), true); EL("sendBtn").disabled = false; return; }
        var msg = '<div class="good" style="margin-top:12px">Sent <b>' + num(d.sent) + '</b> email' + (d.sent === 1 ? "" : "s") +
          (d.failed ? '; <b>' + num(d.failed) + '</b> failed (not marked sent, so the next click retries just them)' : '') + '. ';
        if (d.remaining) msg += '<b>' + num(d.remaining) + '</b> still to go \u2014 click <b>Send</b> again to continue.';
        else msg += 'Everyone eligible for this session has now been emailed.';
        msg += '</div>';
        if (d.stampWriteFailed) msg += '<div class="warn">Some people were sent but their records could not be marked \u2014 <b>Preview again before sending</b> so they are not emailed twice. (' + esc(JSON.stringify(d.stampWriteFailed)) + ')</div>';
        if (d.failures && d.failures.length) {
          msg += '<details><summary>See failed sends</summary><div class="scrollx" style="margin-top:8px"><table class="matrix"><thead><tr><th>Name</th><th>User ID</th><th>Error</th></tr></thead><tbody>' +
            d.failures.map(function (f) { return '<tr><td>' + esc(f.name || "") + '</td><td>' + esc(f.user_id) + '</td><td>' + esc(f.error) + '</td></tr>'; }).join("") +
            '</tbody></table></div></details>';
        }
        EL("sendResult").innerHTML = msg;
        EL("sendBtn").disabled = !d.remaining;   // more to go -> allow another click; done -> leave disabled
      }).catch(function () {
        EL("sendResult").innerHTML = "";
        banner("The send request failed \u2014 some may have gone out. Preview again before retrying.", true);
        EL("sendBtn").disabled = false;
      }).then(function () { busy = false; });
  }

  // Export this session's duty recipients as a mail-merge CSV for SendGrid, then mark them sent.
  var exportedSession = null;
  function downloadRecipients() {
    if (!session()) return;
    if (busy) return; busy = true; EL("downloadBtn").disabled = true; clearBanner();
    banner("Preparing the recipient list\u2026", false);
    fetch("/api/dutyemail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session(), mode: "export" }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { banner(esc(d.error), true); return; }
        var blob = new Blob([d.csv], { type: "text/csv;charset=utf-8;" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a"); a.href = url; a.download = d.filename || "duty-recipients.csv";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        exportedSession = session();
        EL("markBtn").disabled = !d.count;
        banner("Downloaded <b>" + num(d.count) + "</b> duty recipients for " + esc(d.session ? d.session.name : sessionName()) + ". After you\u2019ve sent them in SendGrid, click <b>Mark this batch as sent</b>.", false);
      }).catch(function () { banner("Couldn\u2019t prepare the list \u2014 try again.", true); })
      .then(function () { busy = false; EL("downloadBtn").disabled = false; });
  }
  function markSent() {
    if (!exportedSession) return;
    var sn = (SESSIONS.filter(function (x) { return x.id === exportedSession; })[0] || {}).name || exportedSession;
    if (!window.confirm("Mark this session\u2019s duty recipients (" + sn + ") as sent?\n\nOnly do this AFTER you\u2019ve sent them through SendGrid. They\u2019ll be excluded from future exports and the duty-email list.")) return;
    if (busy) return; busy = true; EL("markBtn").disabled = true; clearBanner();
    fetch("/api/dutyemail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: exportedSession, mode: "marksent" }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { banner(esc(d.error), true); EL("markBtn").disabled = false; return; }
        exportedSession = null;
        banner("Marked <b>" + num(d.marked) + "</b> as sent. They won\u2019t appear in future exports.", false);
        loadSummary();
        if (session()) preview();
      }).catch(function () { banner("Couldn\u2019t mark as sent \u2014 try again.", true); EL("markBtn").disabled = false; })
      .then(function () { busy = false; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();
    loadSummary();
    EL("previewBtn").addEventListener("click", preview);
    EL("downloadBtn").addEventListener("click", downloadRecipients);
    EL("markBtn").addEventListener("click", markSent);
  });
})();
