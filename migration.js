(function () {
  function banner(msg, kind) {
    var b = document.getElementById('banner');
    b.hidden = false; b.className = 'banner ' + (kind || ''); b.innerHTML = msg;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // Render a flat object of label->number as a small table.
  function renderCounts(box, obj, order) {
    var rows = '';
    order.forEach(function (k) {
      if (obj[k.key] === undefined) return;
      var v = obj[k.key];
      if (Array.isArray(v)) v = v.length ? v.join(', ') : '—';
      rows += '<tr><th>' + esc(k.label) + '</th><td class="n">' + esc(v) + '</td></tr>';
    });
    box.innerHTML = '<table>' + rows + '</table>';
    box.style.display = 'block';
  }

  async function call(url, opts) {
    var r = await fetch(url, opts || {});
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  }

  var LAST = null;   // last transfer report, so the export button can use its strandedList

  function csvCell(s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(rows, cols) {
    var out = [cols.join(',')];
    rows.forEach(function (r) { out.push(cols.map(function (c) { return csvCell(r[c]); }).join(',')); });
    return out.join('\r\n');
  }
  function downloadCsv(name, text) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  function parseCsv(text) {
    text = String(text).replace(/^\ufeff/, ''); var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch !== '\r') cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  // ---- Reset ----
  var token = document.getElementById('resetToken');
  var resetBtn = document.getElementById('resetBtn');
  token.addEventListener('input', function () { resetBtn.disabled = token.value.trim() !== 'RESET'; });

  document.getElementById('resetPreview').addEventListener('click', async function () {
    try {
      var d = await call('/api/reset');
      renderCounts(document.getElementById('resetRes'), { BC: (d.counts || {}).BC, Prairies: (d.counts || {}).Prairies, Edmonton: (d.counts || {}).Edmonton, total: d.total },
        [{ key: 'BC', label: 'BC' }, { key: 'Prairies', label: 'Prairies' }, { key: 'Edmonton', label: 'Edmonton' }, { key: 'total', label: 'Total records' }]);
    } catch (e) { banner('Preview failed: ' + e.message, 'err'); }
  });

  resetBtn.addEventListener('click', async function () {
    if (!confirm('Clear ALL volunteer records from the workspace? Events, roles and duties are kept. This cannot be undone — make sure you downloaded a backup.')) return;
    resetBtn.disabled = true;
    try {
      var d = await call('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'RESET' }) });
      banner('Workspace cleared — ' + d.cleared + ' records removed. Events, roles and duties intact.', 'good');
      token.value = '';
      document.getElementById('resetRes').style.display = 'none';
    } catch (e) { banner('Reset failed: ' + e.message, 'err'); resetBtn.disabled = false; }
  });

  // ---- Transfer ----
  var TRES = document.getElementById('tRes');
  var COMMIT = document.getElementById('tCommit');
  var ORDER = [
    { key: 'reviewerBlobs', label: 'Reviewers found' },
    { key: 'reviewActiveRaw', label: 'Marked active in review' },
    { key: 'emailFoldedNew', label: '+ email-matched write-ins folded in' },
    { key: 'reviewActiveIds', label: '= People getting a review area' },
    { key: 'toStable', label: '→ Stable (single area)' },
    { key: 'toReconciliation', label: '→ In reconciliation (contested)' },
    { key: 'reviewedReferrals', label: '↺ Reopened into a new area (already-called)' },
    { key: 'leaders', label: 'Leaders flagged' },
    { key: 'noArea', label: 'Active but no area' },
    { key: 'reviewIdsNotInWorkspace', label: 'Reviewed but not in workspace' },
    { key: 'unknownAreas', label: 'Unrecognized areas' },
  ];
  function showTransfer(d) {
    LAST = d;
    renderCounts(TRES, d, ORDER);
    var w = d.writtenIn || {};
    var html = '';
    var cl = d.contestedList || [];
    if (cl.length) {
      var rev = (d.reconcileTotal || cl.length) - (d.writtenInContested || 0);
      html += '<details class="lst" style="margin-top:10px"><summary>In reconciliation — claimed in 2+ areas (' + cl.length + ')</summary>'
        + '<div class="small" style="margin:6px 0">Each was claimed in more than one area, so the tool can\'t auto-assign — resolve them on the Reconcile screen. This matches the Reconcile page total: ' + rev + ' reviewed + ' + (d.writtenInContested || 0) + ' written-in.</div>'
        + '<table style="margin-top:4px"><tr><th>Name</th><th>Region</th><th>Areas claimed</th><th>Source</th></tr>'
        + cl.map(function (p) { return '<tr><td>' + esc(p.name || ('#' + p.user_id)) + '</td><td>' + esc(p.region || '—') + '</td><td>' + esc((p.areas || []).join(', ')) + '</td><td>' + (p.source === 'writein' ? 'Written-in (No BI)' : 'Reviewed') + '</td></tr>'; }).join('')
        + '</table></details>';
    }
    var rr = d.reviewedReferralList || [];
    if (d.reviewedReferrals) {
      html += '<details class="lst" style="margin-top:10px"><summary>Reopened by review — already-called people moved to a new area (' + d.reviewedReferrals + ')</summary>'
        + '<div class="small" style="margin:6px 0">These people had already been through calling, but this review places them in a different area. They\'re reopened into the new area (caller cleared, ready for a fresh call) with the note “Reopened after a new affinity review.” If they were already entered in Better Impact, they\'re flagged for an iVol correction.</div>'
        + '<table style="margin-top:4px"><tr><th>Name</th><th>Region</th><th>From</th><th>→ To</th></tr>'
        + rr.map(function (p) { return '<tr><td>' + esc(p.name || ('#' + p.user_id)) + '</td><td>' + esc(p.region || '—') + '</td><td>' + esc(p.from || '—') + '</td><td>' + esc(p.to || '—') + '</td></tr>'; }).join('')
        + '</table></details>';
    }
    html += '<table style="margin-top:10px"><tr><th colspan="2">Written-in entries</th></tr>'
      + '<tr><th>Write-in entries (raw)</th><td class="n">' + (w.rawEntries || 0) + '</td></tr>'
      + '<tr><th>Unique people (after merging duplicate entries)</th><td class="n">' + (w.total || 0) + '</td></tr>'
      + '<tr><th>Matched by email → folded into existing record</th><td class="n">' + (w.matchedByEmail || 0) + '</td></tr>'
      + '<tr><th>Matched by phone → folded into existing record</th><td class="n">' + (w.matchedByPhone || 0) + '</td></tr>'
      + '<tr><th>Matched by name → folded into existing record</th><td class="n">' + (w.matchedByName || 0) + '</td></tr>'
      + '<tr><th>JK overrides applied (from a prior re-import)</th><td class="n">' + (d.jkOverridesApplied || 0) + '</td></tr>'
      + '<tr><th>Imported as callable No-BI records</th><td class="n">' + (w.imported || 0) + '</td></tr>'
      + '<tr><th>↳ of those, flagged as possible duplicate</th><td class="n">' + (w.duplicateFlagged || 0) + '</td></tr>'
      + '<tr><th>↳ of those, claimed in 2+ areas → In reconciliation</th><td class="n">' + (d.writtenInContested || 0) + '</td></tr>'
      + '<tr><th><b>Still stranded — no JK and no match</b></th><td class="n"><b>' + (d.strandedCount || w.noRegion || 0) + '</b></td></tr></table>';

    // Stranded workflow: export the list, fill in JKs offline, re-import so the next migration grabs them.
    html += '<div class="strand" style="margin-top:12px;padding:10px;border:1px solid #E6D6A8;border-radius:8px;background:#FFFBF0">'
      + '<div class="small" style="margin-bottom:8px"><b>Stranded write-ins</b> have no Jamatkhana and matched no one by email, phone, or name, so they can\'t be placed. Export them, fill in the <code>ceremony_jk</code> column offline (e.g. “BC - Richmond”), then re-import — the next migration will place them.</div>'
      + '<button id="exportStranded" class="btn ghost2"' + ((d.strandedCount || 0) ? '' : ' disabled') + '>Export stranded (' + (d.strandedCount || 0) + ')</button>'
      + '<span style="display:inline-block;width:14px"></span>'
      + '<label class="small">Re-import corrected JKs: </label><input type="file" id="jkFile" accept=".csv,text/csv">'
      + '<button id="importJk" class="btn ghost2" disabled>Upload</button>'
      + '<div id="jkStatus" class="small" style="margin-top:6px"></div></div>';
    TRES.insertAdjacentHTML('beforeend', html);
    var notes = '';
    var mergedDupes = (w.rawEntries || 0) - (w.total || 0);
    notes += '<div class="ok" style="background:#EEF5F6;border-color:#CFE3E6;color:#1f5560">Reconciling with the review tool: <b>' + (d.reviewActiveRaw || 0) + '</b> people were marked active in review (this should match the review tool). The higher <b>' + (d.reviewActiveIds || 0) + '</b> total adds <b>' + (d.emailFoldedNew || 0) + '</b> email-matched write-ins who weren\'t separately marked active. Write-in entries: <b>' + (w.rawEntries || 0) + '</b> raw' + (mergedDupes > 0 ? ' → <b>' + (w.total || 0) + '</b> unique (' + mergedDupes + ' entered more than once, e.g. into two area cells, and were merged)' : '') + '.</div>';
    notes += '<div class="warn" style="background:#FFF6E5;border-color:#F0D58A;color:#7A5A12">Imported write-ins become callable No-BI records. Possible-duplicate ones carry a flag so the caller confirms with the volunteer and can mark “Duplicate / already registered” to drop them out. Email matches just update the existing person.</div>';
    if (d.strandedCount || w.noRegion) notes += '<div class="warn">' + (d.strandedCount || w.noRegion) + ' write-in people are still stranded (no JK, no email/phone/name match). Use <b>Export stranded</b> below, fill in their Jamatkhana offline, and re-import — the next migration will place them.</div>';
    if (d.reviewIdsNotInWorkspace) notes += '<div class="warn">' + d.reviewIdsNotInWorkspace + ' reviewed people aren\'t in the workspace yet. If this is most of them, run the BI import first (or the IDs don\'t line up — tell me before committing).</div>';
    if (d.unknownAreas && d.unknownAreas.length) notes += '<div class="warn">Unrecognized area name(s): ' + esc(d.unknownAreas.join(', ')) + '. These will still apply, but check the spelling matches the tool\'s areas.</div>';
    if (d.mode === 'commit') notes += '<div class="ok">' + esc(d.note || 'Transfer applied.') + '</div>';
    TRES.insertAdjacentHTML('beforeend', notes);
    wireStranded();
  }

  function wireStranded() {
    var exp = document.getElementById('exportStranded');
    if (exp) exp.addEventListener('click', function () {
      var list = (LAST && LAST.strandedList) || [];
      if (!list.length) return;
      var rows = list.map(function (p) {
        return { match_key: p.match_key, first: p.first, last: p.last, email: p.email, phone: p.phone,
          areas: (p.areas || []).join('; '), ceremony_jk: '' };
      });
      downloadCsv('stranded-writeins-' + new Date().toISOString().slice(0, 10) + '.csv',
        toCsv(rows, ['match_key', 'first', 'last', 'email', 'phone', 'areas', 'ceremony_jk']));
    });
    var file = document.getElementById('jkFile'), imp = document.getElementById('importJk'), st = document.getElementById('jkStatus');
    if (file && imp) {
      file.addEventListener('change', function () { imp.disabled = !file.files.length; });
      imp.addEventListener('click', function () {
        var f = file.files[0]; if (!f) return;
        var reader = new FileReader();
        reader.onload = async function () {
          try {
            var rows = parseCsv(reader.result);
            var header = (rows.shift() || []).map(function (h) { return String(h).trim().toLowerCase(); });
            var ki = header.indexOf('match_key'), ji = header.indexOf('ceremony_jk');
            if (ki < 0 || ji < 0) { st.innerHTML = '<span style="color:#b23">CSV needs a match_key and a ceremony_jk column.</span>'; return; }
            var overrides = [];
            rows.forEach(function (r) {
              if (!r || !r.length) return;
              var key = String(r[ki] || '').trim(); if (!key) return;
              overrides.push({ match_key: key, ceremony_jk: String(r[ji] || '').trim() });
            });
            if (!overrides.length) { st.innerHTML = '<span style="color:#b23">No rows with a match_key found.</span>'; return; }
            imp.disabled = true;
            var d = await call('/api/jkoverrides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides: overrides }) });
            st.innerHTML = '<span style="color:#1a7">Saved ' + d.stored + ' JK correction(s)' + (d.cleared ? ', cleared ' + d.cleared : '') + (d.invalid ? ', <b>skipped ' + d.invalid + ' with an invalid JK</b>' : '') + '. Run Preview again to see them placed, then Commit.</span>';
          } catch (e) { st.innerHTML = '<span style="color:#b23">Upload failed: ' + esc(e.message) + '</span>'; imp.disabled = false; }
        };
        reader.readAsText(f);
      });
    }
  }

  document.getElementById('tPreview').addEventListener('click', async function () {
    try {
      var d = await call('/api/transfer');
      showTransfer(d);
      COMMIT.disabled = d.matched === 0;
      if (!d.matched) banner('Nothing matched — review the preview before committing.', 'err'); else banner('Preview ready — ' + d.matched + ' people would be updated. Review, then commit.', 'good');
    } catch (e) { banner('Preview failed: ' + e.message, 'err'); }
  });

  COMMIT.addEventListener('click', async function () {
    if (!confirm('Apply the review decisions to the workspace now? Single-area people become Stable; contested people go to reconciliation; leaders are flagged. Call state is preserved.')) return;
    COMMIT.disabled = true;
    try {
      var d = await call('/api/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'commit' }) });
      showTransfer(d);
      banner('Transfer committed — ' + d.toStable + ' now Stable, ' + d.toReconciliation + ' in reconciliation, ' + d.leaders + ' leaders.', 'good');
    } catch (e) { banner('Commit failed: ' + e.message, 'err'); COMMIT.disabled = false; }
  });

  // ---- Step 5: accept the team from the uploaded Existing Team Members file ----
  var TEAM = { matched: [], ambiguous: [], notFound: [], counts: {} };
  var teamPick = document.getElementById('teamPick');
  var teamFile = document.getElementById('teamFile');
  var teamFileName = document.getElementById('teamFileName');
  var teamAccept = document.getElementById('teamAccept');
  var teamSelectAll = document.getElementById('teamSelectAll');
  var teamRes = document.getElementById('teamRes');
  var MATCH_LABEL = { email: 'email', phone: 'phone', name: 'name' };
  var SKIP_LABEL = { alreadyAccepted: 'already accepted', assignedToCaller: "on a caller's list", inReconciliation: 'in reconciliation', noArea: 'no area yet', leadership: 'leadership', notFound: 'not found in workspace', notFromReview: 'not from the review', outOfRegion: 'out of region', error: 'could not process' };

  // Read the Existing Team Members .xlsx in the browser and pull {first,last,email,phone,jk} per row.
  function parseTeamFile(file, onRows, onErr) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
        var sheetName = wb.SheetNames.filter(function (n) { return String(n).toLowerCase().indexOf('team member') >= 0; })[0] || wb.SheetNames[0];
        var ws = wb.Sheets[sheetName];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        if (!rows.length) throw new Error('the sheet is empty');
        var headers = (rows[0] || []).map(function (h) { return String(h == null ? '' : h).trim().toLowerCase(); });
        var col = function (want) { return headers.findIndex(function (h) { return h === want || h.indexOf(want) >= 0; }); };
        var ix = { first: col('first name'), last: col('last name'), email: col('email'), phone: col('phone'), jk: col('jamatkhana') };
        if (ix.first < 0 || ix.last < 0 || ix.jk < 0) throw new Error("couldn't find the First Name / Last Name / Jamatkhana columns — is this the Existing Team Members file?");
        var cell = function (row, i) { return i >= 0 ? String(row[i] == null ? '' : row[i]).trim() : ''; };
        var out = [];
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r]; if (!row) continue;
          var first = cell(row, ix.first), last = cell(row, ix.last);
          if (!first && !last) continue;                                   // blank row
          if ((first + ' ' + last).toLowerCase().indexOf('example') >= 0) continue;   // template sample row
          out.push({ first: first, last: last, email: cell(row, ix.email), phone: cell(row, ix.phone), jk: cell(row, ix.jk) });
        }
        onRows(out);
      } catch (e) { onErr(e); }
    };
    reader.onerror = function () { onErr(new Error('could not read the file')); };
    reader.readAsArrayBuffer(file);
  }

  teamPick.addEventListener('click', function () { teamFile.click(); });
  teamFile.addEventListener('change', function () {
    var f = teamFile.files && teamFile.files[0]; if (!f) return;
    teamFileName.textContent = f.name;
    teamSelectAll.style.display = 'none'; teamAccept.style.display = 'none';
    if (typeof XLSX === 'undefined') { teamRes.style.display = 'block'; teamRes.innerHTML = '<div class="warn">Spreadsheet reader did not load — check your connection and retry.</div>'; return; }
    teamRes.style.display = 'block'; teamRes.innerHTML = '<div class="ok" style="margin-top:0">Reading the file…</div>';
    parseTeamFile(f, async function (rows) {
      if (!rows.length) { teamRes.innerHTML = '<div class="warn">No team members found in the file.</div>'; return; }
      teamRes.innerHTML = '<div class="ok" style="margin-top:0">Matching ' + rows.length + ' people to the workspace…</div>';
      try {
        var d = await call('/api/teammatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: rows }) });
        TEAM.matched = (d.matched || []).map(function (m) { m._sel = false; return m; });
        TEAM.ambiguous = d.ambiguous || []; TEAM.notFound = d.notFound || []; TEAM.counts = d.counts || {};
        teamRender();
      } catch (e) { teamRes.innerHTML = '<div class="warn">Match failed: ' + esc(e.message) + '</div>'; }
    }, function (err) { teamRes.innerHTML = '<div class="warn">Could not read the file: ' + esc(err.message) + '</div>'; });
    teamFile.value = '';   // allow re-selecting the same file
  });

  function teamUpdateBtn() {
    var n = TEAM.matched.filter(function (m) { return m.eligible && m._sel; }).length;
    teamAccept.disabled = n === 0;
    teamAccept.textContent = 'Accept selected' + (n ? ' (' + n + ')' : '');
  }
  function teamRender() {
    var elig = TEAM.matched.filter(function (m) { return m.eligible; });
    var skip = TEAM.matched.filter(function (m) { return !m.eligible; });
    var c = TEAM.counts;
    var html = '<div class="ok" style="margin-top:0"><b>' + elig.length + '</b> eligible to mark Accepted'
      + (skip.length ? ' · ' + skip.length + ' skipped' : '')
      + (TEAM.ambiguous.length ? ' · ' + TEAM.ambiguous.length + ' ambiguous' : '')
      + (TEAM.notFound.length ? ' · ' + TEAM.notFound.length + ' not found' : '')
      + ' (of ' + (c.rows || 0) + ' in the file).</div>';

    if (elig.length) {
      var rows = elig.map(function (m) {
        var i = TEAM.matched.indexOf(m);
        var mismatch = m.rowName && m.name && m.rowName.toLowerCase() !== m.name.toLowerCase();
        return '<tr><td><input type="checkbox" class="team-chk" data-i="' + i + '"' + (m._sel ? ' checked' : '') + '></td>'
          + '<td>' + esc(m.name) + (mismatch ? ' <span style="color:#b26b00">(file: ' + esc(m.rowName) + ')</span>' : '') + '</td>'
          + '<td>' + esc(m.final_area || '—') + '</td><td>' + esc(m.region) + '</td><td class="small">by ' + esc(MATCH_LABEL[m.matchedBy] || m.matchedBy) + '</td></tr>';
      }).join('');
      html += '<details class="lst" open><summary>Eligible (' + elig.length + ')</summary>'
        + '<table><tr><th></th><th>Matched person</th><th>Area</th><th>Region</th><th>Match</th></tr>' + rows + '</table></details>';
    }
    if (skip.length) {
      var srows = skip.map(function (m) {
        return '<tr><td>' + esc(m.name) + '</td><td>' + esc(m.final_area || '—') + '</td><td>' + esc(m.region) + '</td><td class="small">' + esc(SKIP_LABEL[m.skipReason] || m.skipReason) + '</td></tr>';
      }).join('');
      html += '<details class="lst"><summary>Matched but skipped (' + skip.length + ')</summary><div class="small">Already handled or not acceptable without a call.</div>'
        + '<table><tr><th>Person</th><th>Area</th><th>Region</th><th>Why skipped</th></tr>' + srows + '</table></details>';
    }
    if (TEAM.ambiguous.length) {
      var arows = TEAM.ambiguous.map(function (a) {
        return '<tr><td>' + esc(a.rowName) + '</td><td class="small">' + esc(a.rowEmail || a.rowPhone || '') + '</td><td class="small">' + a.candidates.length + ': ' + esc(a.candidates.map(function (x) { return x.name + ' (' + x.region + ')'; }).join('; ')) + '</td></tr>';
      }).join('');
      html += '<details class="lst"><summary>Ambiguous — resolve manually (' + TEAM.ambiguous.length + ')</summary><div class="small">These rows matched more than one person, so they are not auto-accepted. Resolve the duplicates first (Duplicates screen), then re-upload.</div>'
        + '<table><tr><th>File row</th><th>Contact</th><th>Matched</th></tr>' + arows + '</table></details>';
    }
    if (TEAM.notFound.length) {
      var nrows = TEAM.notFound.map(function (n) {
        return '<tr><td>' + esc(n.rowName) + '</td><td class="small">' + esc(n.rowEmail || '') + '</td><td class="small">' + esc(n.rowPhone || '') + '</td><td class="small">' + esc(n.rowJk || '') + '</td></tr>';
      }).join('');
      html += '<details class="lst"><summary>Not found here (' + TEAM.notFound.length + ')</summary><div class="small">In the file but not in the workspace — run the transfer above first, or they are not in Better Impact.</div>'
        + '<table><tr><th>Name</th><th>Email</th><th>Phone</th><th>Jamatkhana</th></tr>' + nrows + '</table></details>';
    }

    teamRes.innerHTML = html; teamRes.style.display = 'block';
    teamRes.querySelectorAll('.team-chk').forEach(function (chk) {
      chk.addEventListener('change', function () { TEAM.matched[+chk.dataset.i]._sel = chk.checked; teamUpdateBtn(); });
    });
    teamSelectAll.style.display = elig.length ? '' : 'none';
    teamAccept.style.display = elig.length ? '' : 'none';
    teamUpdateBtn();
  }

  teamSelectAll.addEventListener('click', function () {
    var elig = TEAM.matched.filter(function (m) { return m.eligible; });
    var allSel = elig.length > 0 && elig.every(function (m) { return m._sel; });
    elig.forEach(function (m) { m._sel = !allSel; });
    teamRender();
  });
  teamAccept.addEventListener('click', async function () {
    var sel = TEAM.matched.filter(function (m) { return m.eligible && m._sel; }).map(function (m) { return { user_id: m.user_id, region: m.region }; });
    if (!sel.length) return;
    if (!confirm('Mark ' + sel.length + " person(s) from the file as Accepted, with no call? This is the same as a caller marking them Accepted.")) return;
    teamAccept.disabled = true; teamAccept.textContent = 'Accepting…';
    try {
      var d = await call('/api/bulkaccept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: sel }) });
      var acceptedIds = {}; (d.accepted || []).forEach(function (a) { acceptedIds[String(a.user_id)] = true; });
      var skipById = {}; (d.skippedItems || []).forEach(function (s) { skipById[String(s.user_id)] = s.reason; });
      // Resolve EVERY person we attempted — accepted or skipped — so none loop back into the eligible list.
      var stillOpen = 0;
      sel.forEach(function (s) {
        var m = TEAM.matched.filter(function (x) { return String(x.user_id) === String(s.user_id); })[0];
        if (!m) return;
        m._sel = false;
        if (acceptedIds[String(m.user_id)]) { m.eligible = false; m.skipReason = 'alreadyAccepted'; }
        else if (skipById[String(m.user_id)]) { m.eligible = false; m.skipReason = skipById[String(m.user_id)]; }
        else { stillOpen++; }   // neither accepted nor reported skipped (shouldn't happen) — leave for a retry
      });
      banner('Accepted ' + d.acceptedCount + ' of ' + sel.length + ' selected.' + (stillOpen ? ' ' + stillOpen + ' could not be resolved — try again.' : ''), stillOpen ? 'err' : 'good');
      teamRender();
    } catch (e) { banner('Accept failed: ' + e.message, 'err'); teamAccept.disabled = false; teamUpdateBtn(); }
  });
})();
