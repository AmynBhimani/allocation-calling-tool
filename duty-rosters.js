(function () {
  var DATA = { roster: {}, sessions: [], duties: [], areas: [], canManage: false };
  var PARSED = null;                       // files ready to send
  var TEMPLATE_VERSION = 2;   // v2 adds "Minimum age"
  // Header labels — the reader finds these by scanning, so a team can insert a logo or a note above
  // the table without breaking the import.
  // Column ORDER is cosmetic — the reader maps by header name, so a v1 template (no "Minimum age")
  // still imports, and a blank age simply means no age gate. Keep the wording distinct: "Minimum age"
  // and "Minimum required" both contain "minimum", and colMap() below has to tell them apart.
  var H = ["Duty", "Description", "Remove from this session", "Minimum required", "Leads required",
           "Minimum age", "Check-in time (HH:MM, 24-hour)"];

  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function banner(msg, isErr) { var b = EL("banner"); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL("banner").hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }
  var norm = function (s) { return String(s == null ? "" : s).trim().toLowerCase(); };

  // Excel sheet names: 31 chars max, and [ ] : * ? / \ are illegal. "July 24 Afternoon - Prairies /
  // Edmonton" breaks both rules, so sanitize + dedupe here and keep the real session id in _meta.
  function sheetNameFor(name, used) {
    var s = String(name || "Session").replace(/[\[\]:*?\/\\]/g, "-").replace(/\s+/g, " ").trim();
    // Truncating at 31 can cut mid-phrase and leave a dangling "- ", so tidy the tail. Nothing is lost:
    // the full session name is in the sheet's title row and the real id is in _meta.
    s = s.slice(0, 31).replace(/[\s\-]+$/, "") || "Session";
    var base = s, i = 2;
    while (used[s.toLowerCase()]) { var suffix = " (" + i++ + ")"; s = base.slice(0, 31 - suffix.length) + suffix; }
    used[s.toLowerCase()] = true;
    return s;
  }

  function dutiesForArea(area) {
    return DATA.duties.filter(function (d) { return String(d.area) === area; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }
  // What's already committed for this session x area, so a re-issued template comes back pre-filled.
  function committed(sessionId, area) {
    var cell = ((DATA.roster || {})[sessionId] || {})[area] || [];
    var m = {};
    cell.forEach(function (r) { m[norm(r.duty)] = r; });
    return m;
  }

  var HEADER_ROW = 7;                      // rows 1-6 are the title + instructions + a blank

  function downloadBuf(buf, filename) {
    var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  // Guardrails, not guarantees: Excel only enforces validation on typing, not on paste, so the
  // importer's parsing stays deliberately forgiving. This just stops the honest mistakes.
  function dvRemove() {
    return { type: "list", allowBlank: false, formulae: ['"Keep,Remove"'], showErrorMessage: true,
      errorStyle: "stop", errorTitle: "Choose from the list", error: "Pick Keep or Remove." };
  }
  function dvWhole(what) {
    return { type: "whole", operator: "greaterThanOrEqual", formulae: [0], allowBlank: true,
      showErrorMessage: true, errorStyle: "stop", errorTitle: what, error: "Enter a whole number (0 or more)." };
  }
  function dvTime() {
    return { type: "any", showInputMessage: true, promptTitle: "Check-in time", prompt: "24-hour HH:MM \u2014 e.g. 07:30" };
  }

  function buildTemplate(area) {
    if (!window.ExcelJS) { banner("The spreadsheet library didn\u2019t load \u2014 check your connection and reload the page.", true); return; }
    var wb = new ExcelJS.Workbook();
    wb.creator = "VE Allocation Tool";
    var used = {};
    var metaRows = [["Sheet", "SessionId", "SessionName", "Area", "Version"]];

    DATA.sessions.forEach(function (s) {
      var sn = sheetNameFor(s.name, used);
      metaRows.push([sn, s.id, s.name, area, TEMPLATE_VERSION]);
      var ws = wb.addWorksheet(sn);
      ws.columns = [{ width: 32 }, { width: 42 }, { width: 24 }, { width: 17 }, { width: 15 }, { width: 13 }, { width: 26 }];
      ws.addRow([area + " \u2014 " + s.name]);
      ws.addRow(["Fill in one row per duty for THIS session. Each sheet is a different session."]);
      ws.addRow(["To drop a duty for this session only, choose Remove in the \u201cRemove from this session\u201d column. Minimum required is a floor, not a cap \u2014 more is fine."]);
      ws.addRow(["Check-in time: 24-hour HH:MM, e.g. 07:30. Add any new duties in the blank rows at the bottom \u2014 don\u2019t delete rows."]);
      ws.addRow(["Minimum age applies to THIS duty only \u2014 use it where a duty needs to be stricter than the area. Leave blank for no age limit. Leads are EXTRA people: \u201cLeads required 2\u201d means 2 more on top of the minimum, and they check in an hour early."]);
      ws.addRow([]);
      ws.addRow(H.slice());
      ws.getRow(1).font = { bold: true, size: 13 };
      ws.getRow(HEADER_ROW).font = { bold: true };

      var prior = committed(s.id, area);
      var list = dutiesForArea(area);
      list.forEach(function (d) {
        var p = prior[norm(d.name)];
        ws.addRow([d.name, d.description || "", "Keep", p ? p.min : null, p ? p.leads : null,
                   p && p.minAge ? p.minAge : null, p ? p.checkIn : ""]);
      });
      for (var i = 0; i < 15; i++) ws.addRow(["", "", "Keep", null, null, null, ""]);   // room to add new duties

      var last = HEADER_ROW + list.length + 15;
      for (var r = HEADER_ROW + 1; r <= last; r++) {
        ws.getCell(r, 3).dataValidation = dvRemove();
        ws.getCell(r, 4).dataValidation = dvWhole("Minimum required");
        ws.getCell(r, 5).dataValidation = dvWhole("Leads required");
        ws.getCell(r, 6).dataValidation = dvWhole("Minimum age");
        ws.getCell(r, 7).dataValidation = dvTime();
      }
      ws.views = [{ state: "frozen", ySplit: HEADER_ROW }];      // headers stay put while they scroll
    });

    var mws = wb.addWorksheet("_meta");
    mws.state = "hidden";
    metaRows.forEach(function (r) { mws.addRow(r); });

    var safe = area.replace(/[^A-Za-z0-9 &-]/g, "").trim();
    return wb.xlsx.writeBuffer().then(function (buf) {
      downloadBuf(buf, "Duty roster - " + safe + ".xlsx");
    }).catch(function (e) { banner("Couldn\u2019t build the template: " + esc(e.message), true); });
  }

  function renderAreas() {
    var host = EL("areas");
    if (!DATA.sessions.length) { host.innerHTML = '<div class="small">No sessions are configured yet \u2014 add them on the Events screen first.</div>'; return; }
    host.innerHTML = DATA.areas.map(function (a) {
      var n = dutiesForArea(a).length;
      return '<div class="arearow"><div><div class="an">' + esc(a) + '</div>'
        + '<div class="ac">' + num(n) + ' current dut' + (n === 1 ? "y" : "ies") + '</div></div>'
        + '<button class="dl" data-area="' + esc(a) + '">Download template</button></div>';
    }).join("");
    host.querySelectorAll("[data-area]").forEach(function (b) {
      b.addEventListener("click", function () { buildTemplate(b.dataset.area); });
    });
  }

  // ---- reading the filled-in workbooks -------------------------------------
  function readSheetRows(ws) { return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true }); }
  // Find the header row by content, not position.
  function headerRow(rows) {
    for (var i = 0; i < Math.min(rows.length, 40); i++) {
      var r = (rows[i] || []).map(norm);
      if (r.indexOf("duty") >= 0 && r.some(function (c) { return c.indexOf("minimum") >= 0; })) return i;
    }
    return -1;
  }
  function colMap(hdr) {
    var m = {};
    (hdr || []).forEach(function (c, i) {
      var s = norm(c);
      if (!s) return;
      if (s === "duty") m.duty = i;
      else if (s.indexOf("description") >= 0) m.description = i;
      else if (s.indexOf("remove") >= 0) m.remove = i;
      // "Minimum age" BEFORE "Minimum required": both contain "minimum", and whichever is tested
      // first wins. Reversed, the age column would silently overwrite the headcount column.
      else if (s.indexOf("age") >= 0) m.minAge = i;
      else if (s.indexOf("minimum") >= 0) m.min = i;
      else if (s.indexOf("lead") >= 0) m.leads = i;
      else if (s.indexOf("check") >= 0) m.checkIn = i;
    });
    return m;
  }
  function readWorkbook(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array" });
          var metaWs = wb.Sheets["_meta"];
          var out = { fileName: file.name, area: "", entries: [] }, sheetToSession = {};
          if (metaWs) {
            var mrows = readSheetRows(metaWs);
            for (var i = 1; i < mrows.length; i++) {
              var r = mrows[i] || [];
              if (!r[0]) continue;
              sheetToSession[String(r[0])] = String(r[1] || "");
              if (r[3]) out.area = String(r[3]).trim();
            }
          }
          if (!out.area) {           // fallback: the title cell reads "<Area> — <Session>"
            for (var si = 0; si < wb.SheetNames.length; si++) {
              var t = (readSheetRows(wb.Sheets[wb.SheetNames[si]])[0] || [])[0];
              if (t && String(t).indexOf("\u2014") > 0) { out.area = String(t).split("\u2014")[0].trim(); break; }
            }
          }
          wb.SheetNames.forEach(function (sn) {
            if (sn === "_meta") return;
            var rows = readSheetRows(wb.Sheets[sn]);
            var hi = headerRow(rows);
            if (hi < 0) return;                                   // not a duty sheet
            var m = colMap(rows[hi]);
            if (m.duty == null) return;
            var sid = sheetToSession[sn] || "";
            if (!sid) {                                           // fallback: match the sheet tab to a session name
              var hit = DATA.sessions.filter(function (s) { return norm(s.name).slice(0, 31) === norm(sn); })[0]
                || DATA.sessions.filter(function (s) { return norm(s.name).indexOf(norm(sn)) === 0; })[0];
              if (hit) sid = hit.id;
            }
            for (var ri = hi + 1; ri < rows.length; ri++) {
              var row = rows[ri] || [];
              var name = row[m.duty];
              if (name == null || String(name).trim() === "") continue;
              out.entries.push({
                sessionId: sid, sheet: sn, row: ri + 1,
                duty: String(name).trim(),
                description: m.description != null ? row[m.description] : "",
                remove: m.remove != null ? row[m.remove] : "",
                min: m.min != null ? row[m.min] : "",
                leads: m.leads != null ? row[m.leads] : "",
                minAge: m.minAge != null ? row[m.minAge] : "",     // absent in a v1 template -> no age gate
                checkIn: m.checkIn != null ? row[m.checkIn] : "",
              });
            }
          });
          resolve(out);
        } catch (e) { resolve({ fileName: file.name, area: "", entries: [], readError: e.message }); }
      };
      reader.onerror = function () { resolve({ fileName: file.name, area: "", entries: [], readError: "could not read the file" }); };
      reader.readAsArrayBuffer(file);
    });
  }

  function onFiles(e) {
    clearBanner();
    var files = [].slice.call(e.target.files || []);
    if (!files.length) return;
    EL("fileNote").textContent = "Reading " + files.length + " file(s)\u2026";
    Promise.all(files.map(readWorkbook)).then(function (res) {
      var bad = res.filter(function (r) { return r.readError; });
      PARSED = res.filter(function (r) { return !r.readError; });
      var rows = PARSED.reduce(function (n, f) { return n + f.entries.length; }, 0);
      EL("fileNote").innerHTML = num(PARSED.length) + " file(s) \u00b7 " + num(rows) + " row(s) read"
        + (bad.length ? ' \u00b7 <b style="color:#9b5b50">' + bad.length + " couldn\u2019t be read</b>" : "");
      if (bad.length) banner("Couldn\u2019t read: " + bad.map(function (b) { return esc(b.fileName) + " (" + esc(b.readError) + ")"; }).join(", "), true);
      EL("previewBtn").disabled = !PARSED.length;
      EL("commitBtn").disabled = true;
    });
  }

  function run(commit) {
    if (!PARSED || !PARSED.length) return;
    clearBanner();
    if (commit && !confirm("Commit these duty rosters? New duties will also be added to the master catalog.")) return;
    EL("previewBtn").disabled = true; EL("commitBtn").disabled = true;
    EL("out").innerHTML = '<div class="card"><div class="small">' + (commit ? "Committing" : "Working") + "\u2026</div></div>";
    fetch("/api/sessionduties", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: PARSED, commit: !!commit }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          // A refused commit still carries the detail — show WHO is holding each duty, not just a banner.
          EL("out").innerHTML = d.blocked ? '<div class="card">' + blockedHtml(d) + "</div>" : "";
          banner(esc(d.error), true); EL("previewBtn").disabled = false; return;
        }
        render(d);
        EL("previewBtn").disabled = false;
        // A preview carrying blocked removals must not arm Commit: it would only be refused server-side.
        EL("commitBtn").disabled = !!commit || !!(d.blockedCount);
        if (commit) { banner("Committed. " + num(d.counts.kept) + " duties rostered\u00b7 " + num(d.catalogAdded || 0) + " new duties added to the catalog.", false); load(); }
      })
      .catch(function (e) { EL("out").innerHTML = ""; banner("Failed: " + esc(e.message), true); EL("previewBtn").disabled = false; });
  }

  function listBlock(title, rows, isWarn) {
    if (!rows || !rows.length) return "";
    return '<details><summary>' + esc(title) + " (" + num(rows.length) + ")</summary>"
      + '<table class="matrix"><tr><th>Where</th><th>Duty</th><th>' + (isWarn ? "Note" : "Problem") + "</th></tr>"
      + rows.slice(0, 200).map(function (r) {
          return "<tr><td>" + esc(r.where) + "</td><td>" + esc(r.duty || "\u2014") + "</td><td>" + esc(r.issue) + "</td></tr>";
        }).join("") + "</table></details>";
  }

  // Duties that could not be removed because volunteers are already doing them. Deliberately loud and
  // never collapsed into a <details>: it is the one thing on this screen that stops an import dead.
  function blockedHtml(d) {
    var b = d.blocked || [];
    if (!b.length) return "";
    var html = '<div class="sub2" style="color:#7d4a41">Not removed \u2014 already assigned in iVolunteer ('
      + num(b.length) + ")</div>"
      + '<div class="small" style="margin-bottom:8px">These duties were left exactly as they were; <b>everything else in the file still applies</b>. '
      + 'Better Impact is already holding these shifts, so they have to be backed out there first \u2014 the app '
      + 'won\u2019t leave the two out of step. Deal with those volunteers, then mark Remove again on a later upload.</div>'
      + '<table class="matrix"><tr><th>Session</th><th>Area</th><th>Duty</th><th class="n">Holding it</th><th>Who</th></tr>';
    b.forEach(function (r) {
      var shown = r.holders || [];
      var who = shown.map(function (h) { return esc(h.name) + (h.state ? ' <span class="small">(' + esc(h.state) + ")</span>" : ""); }).join(", ");
      if ((r.holderCount || 0) > shown.length) who += " \u2026and " + num(r.holderCount - shown.length) + " more";
      html += "<tr><td>" + esc(r.sessionName) + "</td><td>" + esc(r.area) + "</td><td>" + esc(r.duty)
        + '</td><td class="n">' + num(r.holderCount) + "</td><td>" + who + "</td></tr>";
    });
    return html + "</table>";
  }

  function render(d) {
    var c = d.counts || {};
    var html = '<div class="card">';
    html += '<div class="small"><b>' + esc(d.mode === "commit" ? "Committed" : "Preview") + "</b> \u00b7 "
      + esc((d.areasTouched || []).join(", ") || "no areas") + "</div>";
    html += '<div class="kpis">'
      + '<div class="kpi"><div class="n">' + num(c.kept) + '</div><div class="l">duties rostered</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.removed) + '</div><div class="l">removed from a session</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.added) + '</div><div class="l">new duties</div></div>'
      + (d.problemCount ? '<div class="kpi flag"><div class="n">' + num(d.problemCount) + '</div><div class="l">rows I couldn\u2019t use</div></div>' : "")
      + "</div>";
    html += '<div class="small">' + esc(d.note || "") + "</div>";

    if (d.problemCount) html += '<div class="warn"><b>' + num(d.problemCount) + " row(s) couldn\u2019t be used</b> and are not in the roster. Fix them in the template and load it again \u2014 everything else below is fine to commit.</div>";
    else if (c.kept) html += '<div class="good">Every row read cleanly.</div>';

    (d.summary || []).forEach(function (s) {
      html += '<div class="sub2">' + esc(s.name) + "</div>";
      html += '<table class="matrix"><tr><th>Area</th><th class="n">Duties</th><th class="n">Minimum total</th>'
        + '<th class="n">Leads (extra)</th><th class="n">People needed</th><th class="n">No check-in time</th></tr>'
        + s.areas.map(function (a) {
            return "<tr><td>" + esc(a.area) + '</td><td class="n">' + num(a.duties) + '</td><td class="n">' + num(a.minTotal)
              + '</td><td class="n">' + num(a.leadsTotal) + '</td><td class="n"><b>' + num(a.peopleNeeded) + "</b>"
              + '</td><td class="n">' + (a.noTime ? '<b style="color:#9b5b50">' + num(a.noTime) + "</b>" : "\u2014") + "</td></tr>";
          }).join("") + "</table>";
      // Every parsed row, so the check-in times can be eyeballed before committing.
      s.areas.forEach(function (a) {
        var derived = a.derived || [];
        html += '<details><summary>' + esc(a.area) + " \u2014 " + num(a.duties) + " duties"
          + (derived.length ? " + " + num(derived.length) + " lead" + (derived.length === 1 ? "" : "s") : "")
          + ", " + num(a.peopleNeeded) + " people</summary>"
          + '<table class="matrix"><tr><th>Duty</th><th class="n">Minimum</th><th class="n">Leads</th>'
          + '<th class="n">Min age</th><th>Check-in</th></tr>'
          + a.rows.map(function (r) {
              return "<tr><td>" + esc(r.duty) + (r.isNew ? '<span class="newpill">new</span>' : "")
                + '</td><td class="n">' + num(r.min) + '</td><td class="n">' + num(r.leads)
                + '</td><td class="n">' + (r.minAge ? num(r.minAge) + "+" : '<span class="small">any</span>') + "</td><td>"
                + (r.checkIn ? esc(r.checkIn) : '<span style="color:#9b5b50">not set</span>') + "</td></tr>";
            }).join("")
          // The lead duties the ENGINE will generate from the Leads column, derived by its own
          // function rather than re-implemented here. Shown at import because this is where
          // "leads 2" quietly becomes two MORE people to find — better seen now than discovered
          // on the allocation report.
          + derived.map(function (r) {
              return '<tr style="color:#6b7280"><td>' + esc(r.duty) + '<span class="small"> \u2014 created from '
                + esc(r.leadOf) + "\u2019s leads</span></td>"
                + '<td class="n">' + num(r.min) + '</td><td class="n">\u2014</td><td class="n">'
                + (r.minAge ? num(r.minAge) + "+" : '<span class="small">any</span>') + "</td><td>"
                + (r.checkIn ? esc(r.checkIn) : '<span class="small">\u2014</span>') + "</td></tr>";
            }).join("")
          + "</table>"
          + (derived.length ? '<div class="small">Lead duties are created automatically and are <b>extra people</b>, '
              + "checking in an hour before their duty. The areas pick who fills them on the review screen \u2014 "
              + "the allocation leaves them empty.</div>" : "")
          + "</details>";
      });
    });

    html += blockedHtml(d);
    if ((d.newDuties || []).length) {
      html += '<div class="sub2">New duties to add to the catalog</div>'
        + '<table class="matrix"><tr><th>Area</th><th>Duty</th><th>Description</th></tr>'
        + d.newDuties.map(function (x) { return "<tr><td>" + esc(x.area) + "</td><td>" + esc(x.name) + "</td><td>" + esc(x.description || "\u2014") + "</td></tr>"; }).join("")
        + "</table>";
    }
    if ((d.removed || []).length) {
      html += '<details><summary>Removed from a session (' + num(d.removed.length) + ")</summary>"
        + '<table class="matrix"><tr><th>Session</th><th>Area</th><th>Duty</th></tr>'
        + d.removed.map(function (r) { return "<tr><td>" + esc(r.sessionName) + "</td><td>" + esc(r.area) + "</td><td>" + esc(r.duty) + "</td></tr>"; }).join("")
        + "</table></details>";
    }
    html += listBlock("Rows I couldn\u2019t use", d.problems, false);
    html += listBlock("Worth a look", d.warnings, true);
    html += "</div>";
    EL("out").innerHTML = html;
  }

  function load() {
    return fetch("/api/sessionduties").then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { banner(esc(d.error), true); return; }
      DATA = d;
      EL("sessLine").innerHTML = DATA.sessions.length
        ? "Sessions: <b>" + DATA.sessions.map(function (s) { return esc(s.name); }).join("</b> \u00b7 <b>") + "</b>"
        : "No sessions configured yet.";
      renderAreas();
      if (!DATA.canManage) {
        EL("previewBtn").disabled = true; EL("commitBtn").disabled = true;
        EL("fileNote").textContent = "Read-only \u2014 only an admin can import rosters.";
      }
    }).catch(function (e) { banner("Could not load: " + esc(e.message), true); });
  }

  fetch("/.auth/me").then(function (r) { return r.json(); }).then(function (me) {
    var cp = me && me.clientPrincipal;
    if (cp) EL("whoami").innerHTML = "<b>" + esc(cp.userDetails) + "</b>";
  }).catch(function () {});
  EL("file").addEventListener("change", onFiles);
  EL("previewBtn").addEventListener("click", function () { run(false); });
  EL("commitBtn").addEventListener("click", function () { run(true); });
  load();
})();
