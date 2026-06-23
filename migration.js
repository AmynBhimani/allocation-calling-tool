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
    { key: 'reviewActiveIds', label: 'People reviewed' },
    { key: 'matched', label: 'Matched in workspace' },
    { key: 'toStable', label: '→ Stable (single area)' },
    { key: 'toReconciliation', label: '→ In reconciliation (contested)' },
    { key: 'leaders', label: 'Leaders flagged' },
    { key: 'noArea', label: 'Active but no area' },
    { key: 'reviewIdsNotInWorkspace', label: 'Reviewed but not in workspace' },
    { key: 'unknownAreas', label: 'Unrecognized areas' },
  ];
  function showTransfer(d) {
    renderCounts(TRES, d, ORDER);
    var w = d.writtenIn || {};
    var html = '';
    html += '<table style="margin-top:10px"><tr><th colspan="2">Written-in people (' + (w.total || 0) + ')</th></tr>'
      + '<tr><th>Matched by email → folded into existing record</th><td class="n">' + (w.matchedByEmail || 0) + '</td></tr>'
      + '<tr><th>Imported as callable No-BI records</th><td class="n">' + (w.imported || 0) + '</td></tr>'
      + '<tr><th>↳ of those, flagged as possible duplicate</th><td class="n">' + (w.duplicateFlagged || 0) + '</td></tr>'
      + '<tr><th>Couldn\'t place (no region from Jamatkhana)</th><td class="n">' + (w.noRegion || 0) + '</td></tr></table>';
    TRES.insertAdjacentHTML('beforeend', html);
    var notes = '';
    notes += '<div class="warn" style="background:#FFF6E5;border-color:#F0D58A;color:#7A5A12">Imported write-ins become callable No-BI records. Possible-duplicate ones carry a flag so the caller confirms with the volunteer and can mark “Duplicate / already registered” to drop them out. Email matches just update the existing person.</div>';
    if (w.noRegion) notes += '<div class="warn">' + w.noRegion + ' written-in people had no region in their Jamatkhana field, so they weren\'t imported. They need a JK like “BC - …” to be placed.</div>';
    if (d.reviewIdsNotInWorkspace) notes += '<div class="warn">' + d.reviewIdsNotInWorkspace + ' reviewed people aren\'t in the workspace yet. If this is most of them, run the BI import first (or the IDs don\'t line up — tell me before committing).</div>';
    if (d.unknownAreas && d.unknownAreas.length) notes += '<div class="warn">Unrecognized area name(s): ' + esc(d.unknownAreas.join(', ')) + '. These will still apply, but check the spelling matches the tool\'s areas.</div>';
    if (d.mode === 'commit') notes += '<div class="ok">' + esc(d.note || 'Transfer applied.') + '</div>';
    TRES.insertAdjacentHTML('beforeend', notes);
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
})();
