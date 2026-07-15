(function () {
  var EVENTS = [], LAST = null;
  function EL(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function banner(msg, isErr) { var b = EL('banner'); b.hidden = false; b.className = "banner" + (isErr ? " err" : ""); b.innerHTML = msg; }
  function clearBanner() { EL('banner').hidden = true; }
  function num(n) { return (n || 0).toLocaleString(); }

  function didars() { return EVENTS.filter(function (e) { return !e.parent && e.active !== false; }); }
  function sessionsOf(id) { return EVENTS.filter(function (e) { return e.parent === id && e.active !== false; }); }
  function currentEvent() { return EL('event').value || ""; }

  function showScope() {
    var d = didars().filter(function (x) { return x.id === currentEvent(); })[0];
    if (!d) { EL('scope').textContent = didars().length ? "" : "No Didars configured — add them on the Events screen."; return; }
    var ss = sessionsOf(d.id);
    EL('scope').textContent = (d.regions || []).join(', ') + " \u00b7 " + ss.length + " session" + (ss.length === 1 ? "" : "s")
      + (ss.length ? "" : " \u2014 add sessions on the Events screen first");
  }

  function loadEvents() {
    return fetch('/api/events').then(function (r) { return r.json(); }).then(function (d) {
      EVENTS = (d && d.events) || [];
      var ds = didars();
      EL('event').innerHTML = ds.length
        ? ds.map(function (d2) { return '<option value="' + esc(d2.id) + '">' + esc(d2.name) + '</option>'; }).join('')
        : '<option value="">(no Didars configured)</option>';
      showScope();
    }).catch(function () { EL('scope').textContent = "Couldn't load events."; });
  }

  function run(commit) {
    clearBanner();
    var ev = currentEvent();
    if (!ev) { banner('Pick a Didar.', true); return; }
    if (commit && !confirm('Commit session allocation for this Didar? This writes each accepted volunteer\u2019s session.')) return;
    EL('runBtn').disabled = true; EL('commitBtn').disabled = true;
    EL('out').innerHTML = '<div class="card"><div class="small">' + (commit ? 'Committing' : 'Working') + '\u2026</div></div>';
    fetch('/api/sessionalloc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: ev, commit: !!commit })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { EL('out').innerHTML = ''; banner(esc(d.error), true); EL('runBtn').disabled = false; return; }
      LAST = d; render(d);
      EL('runBtn').disabled = false;
      EL('commitBtn').disabled = !!commit;                 // committed -> preview again before re-committing
      if (commit) banner('Committed. ' + num(d.counts.placed) + ' accepted volunteers are now in their sessions.', false);
    }).catch(function (e) {
      EL('out').innerHTML = ''; banner('Failed: ' + esc(e.message), true); EL('runBtn').disabled = false;
    });
  }

  function rosterTable(d) {
    var areas = d.areasPresent || [];
    var html = '<table class="matrix"><tr><th>Session</th><th class="n">Jamatkhanas</th>'
      + areas.map(function (a) { return '<th class="n">' + esc(a) + '</th>'; }).join('')
      + '<th class="n">Total</th></tr>';
    var totals = {}, grand = 0;
    (d.sessions || []).forEach(function (s) {
      html += '<tr><td><span class="sessname">' + esc(s.name) + '</span></td><td class="n">' + num(s.jkCount) + '</td>'
        + areas.map(function (a) {
            var v = (s.byArea || {})[a] || 0; totals[a] = (totals[a] || 0) + v;
            return '<td class="n">' + (v || '') + '</td>';
          }).join('')
        + '<td class="n">' + num(s.total) + '</td></tr>';
      grand += s.total;
    });
    html += '<tr class="tot"><td>All sessions</td><td class="n"></td>'
      + areas.map(function (a) { return '<td class="n">' + num(totals[a]) + '</td>'; }).join('')
      + '<td class="n">' + num(grand) + '</td></tr></table>';
    return html;
  }

  function listBlock(title, rows, cols) {
    if (!rows || !rows.length) return '';
    var head = '<tr>' + cols.map(function (c) { return '<th>' + esc(c.h) + '</th>'; }).join('') + '</tr>';
    var body = rows.slice(0, 200).map(function (r) {
      return '<tr>' + cols.map(function (c) { return '<td>' + esc(r[c.k] == null ? '\u2014' : r[c.k]) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var more = rows.length > 200 ? '<div class="small">Showing 200 of ' + num(rows.length) + '.</div>' : '';
    return '<details><summary>' + esc(title) + ' (' + num(rows.length) + ')</summary>'
      + '<table class="matrix">' + head + body + '</table>' + more + '</details>';
  }

  function render(d) {
    var c = d.counts || {};
    var html = '<div class="card">';
    html += '<div class="small">' + esc(d.eventName || '') + ' \u00b7 ' + (d.regions || []).join(', ')
      + ' \u00b7 <b>' + esc(d.mode === 'commit' ? 'committed' : 'preview') + '</b></div>';
    html += '<div class="kpis">'
      + '<div class="kpi"><div class="n">' + num(c.accepted) + '</div><div class="l">accepted volunteers</div></div>'
      + '<div class="kpi"><div class="n">' + num(c.placed) + '</div><div class="l">placed in a session</div></div>'
      + (c.unmappedJk ? '<div class="kpi flag"><div class="n">' + num(c.unmappedJk) + '</div><div class="l">Jamatkhana not mapped</div></div>' : '')
      + (c.duplicateJk ? '<div class="kpi flag"><div class="n">' + num(c.duplicateJk) + '</div><div class="l">Jamatkhana in 2+ sessions</div></div>' : '')
      + (c.noJk ? '<div class="kpi flag"><div class="n">' + num(c.noJk) + '</div><div class="l">no Jamatkhana on file</div></div>' : '')
      + (c.noArea ? '<div class="kpi flag"><div class="n">' + num(c.noArea) + '</div><div class="l">accepted, no confirmed area</div></div>' : '')
      + '</div>';
    html += '<div class="small">' + esc(d.note || '') + '</div>';

    // Mapping errors first — these block people from being placed.
    if ((d.duplicateJks || []).length) {
      html += '<div class="warn"><b>' + num(d.duplicateJks.length) + ' Jamatkhana(s) are claimed by more than one session.</b> '
        + 'Their volunteers are left unplaced rather than guessed at — fix the session Jamatkhana lists on the Events screen, then preview again.<br>'
        + d.duplicateJks.map(function (x) {
            return '\u2022 <b>' + esc(x.jk) + '</b> \u2014 in ' + x.sessions.map(function (s) { return esc(s.name); }).join(' and ');
          }).join('<br>') + '</div>';
    }
    if ((d.unmappedJks || []).length) {
      var tot = d.unmappedJks.reduce(function (a, x) { return a + x.accepted; }, 0);
      html += '<div class="warn"><b>' + num(d.unmappedJks.length) + ' Jamatkhana(s) with ' + num(tot)
        + ' accepted volunteers aren\u2019t on any session\u2019s list.</b> Add them to a session on the Events screen to place these people.'
        + '<table class="matrix" style="margin-top:9px"><tr><th>Jamatkhana</th><th class="n">Accepted volunteers</th></tr>'
        + d.unmappedJks.map(function (x) { return '<tr><td>' + esc(x.jk) + '</td><td class="n">' + num(x.accepted) + '</td></tr>'; }).join('')
        + '</table></div>';
    }
    if (!(d.duplicateJks || []).length && !(d.unmappedJks || []).length && c.accepted) {
      html += '<div class="good">Every accepted volunteer\u2019s Jamatkhana maps to exactly one session.</div>';
    }
    if (c.staleWithDuty) {
      html += '<div class="warn"><b>' + num(c.staleWithDuty) + ' volunteer(s)</b> no longer belong to a session they already hold an assigned duty in. '
        + 'Their duty was kept, not dropped — review these before the duty round.</div>';
    }

    html += '<div class="sub2">Session rosters by area</div>' + rosterTable(d);

    var changes = '<div class="small" style="margin-top:10px">'
      + (d.mode === 'commit'
        ? 'Written: ' + Object.keys(d.written || {}).map(function (R) { return esc(R) + ' ' + num(d.written[R]); }).join(' \u00b7 ')
        : num(d.changed) + ' record(s) would change \u2014 ' + num(c.added) + ' new session row(s), ' + num(c.refreshed)
          + ' refreshed, ' + num(c.removed) + ' stale row(s) removed, ' + num(c.kept) + ' already correct.')
      + '</div>';
    html += changes;

    html += listBlock('Accepted, but no Jamatkhana on file', d.noJkList, [{ h: 'Name', k: 'name' }, { h: 'Region', k: 'region' }, { h: 'Area', k: 'area' }]);
    html += listBlock('Accepted, but no confirmed area', d.noAreaList, [{ h: 'Name', k: 'name' }, { h: 'Region', k: 'region' }, { h: 'Jamatkhana', k: 'jk' }]);
    html += listBlock('Stale session row with an assigned duty', d.staleList, [{ h: 'Name', k: 'name' }, { h: 'Region', k: 'region' }]);
    html += '</div>';
    EL('out').innerHTML = html;
  }

  fetch('/.auth/me').then(function (r) { return r.json(); }).then(function (me) {
    var cp = me && me.clientPrincipal;
    if (cp) EL('whoami').innerHTML = '<b>' + esc(cp.userDetails) + '</b>';
  }).catch(function () {});

  EL('event').addEventListener('change', function () { showScope(); EL('commitBtn').disabled = true; EL('out').innerHTML = ''; });
  EL('runBtn').addEventListener('click', function () { run(false); });
  EL('commitBtn').addEventListener('click', function () { run(true); });
  loadEvents();
})();
