let EVENTS = [];
let JK_DATA = null;          // { region: [{jk,total,accepted}] } — lazy-loaded from /api/jklist
let pendingJks = [];         // JK selection for the "add" form (before the session exists)
let modalCtx = null;         // { mode:'add'|'edit', sessionId, didarId }

function banner(msg, isErr) {
  const b = document.getElementById('banner');
  b.hidden = false; b.className = "banner" + (isErr ? " err" : "");
  b.innerHTML = msg;
}
function clearBanner() { document.getElementById('banner').hidden = true; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function boot() {
  try {
    const me = await (await fetch('/.auth/me')).json();
    const cp = me && me.clientPrincipal;
    if (cp) document.getElementById('whoami').innerHTML = `<b>${esc(cp.userDetails)}</b>`;
  } catch (e) {}
  document.getElementById('type').addEventListener('change', onType);
  document.getElementById('parent').addEventListener('change', onParentChange);
  document.getElementById('addBtn').addEventListener('click', add);
  document.getElementById('jkChooseBtn').addEventListener('click', () => {
    const pid = document.getElementById('parent').value;
    if (!pid) { banner('Pick a parent Didar first.', true); return; }
    openJkModal({ mode: 'add', didarId: pid });
  });
  document.getElementById('jkModalCancel').addEventListener('click', () => document.getElementById('jkModal').close());
  document.getElementById('jkModalSave').addEventListener('click', saveJkModal);
  document.getElementById('jkSelAll').addEventListener('click', () => {
    document.querySelectorAll('#jkModalChecks .jk-cb:not(:disabled)').forEach(c => c.checked = true);
  });
  document.getElementById('jkClear').addEventListener('click', () => {
    document.querySelectorAll('#jkModalChecks .jk-cb:not(:disabled)').forEach(c => c.checked = false);
  });
  await load();
  onType();
}

function onType() {
  const isSession = document.getElementById('type').value === 'session';
  document.getElementById('parentField').classList.toggle('hide', !isSession);
  document.getElementById('jkField').classList.toggle('hide', !isSession);
  document.getElementById('regionsField').classList.toggle('hide', isSession); // regions are a Didar property
  if (isSession) { pendingJks = []; updateJkSummary(); loadJkData(); }          // prefetch JKs in the background
}
function onParentChange() {
  // JKs are Didar-specific, so a parent change resets the pending selection.
  pendingJks = []; updateJkSummary();
}
function didars() { return EVENTS.filter(e => !e.parent); }
function didarById(id) { return EVENTS.find(e => e.id === id && !e.parent); }
function fillParents() {
  const sel = document.getElementById('parent');
  const cur = sel.value;
  const ds = didars();
  sel.innerHTML = ds.length
    ? ds.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')
    : '<option value="">(create a Didar first)</option>';
  if (cur && ds.some(d => d.id === cur)) sel.value = cur;
}

async function load() {
  document.getElementById('count').textContent = "Loading…";
  try {
    const r = await fetch('/api/events');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status));
    const d = await r.json();
    EVENTS = d.events || [];
    render(); fillParents();
  } catch (e) {
    document.getElementById('count').textContent = "Couldn't load events: " + e.message;
  }
}

// ---- Jamatkhana data + checklist ------------------------------------------
async function loadJkData() {
  if (JK_DATA) return JK_DATA;
  try {
    const r = await fetch('/api/jklist');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status));
    JK_DATA = (await r.json()).regions || {};
  } catch (e) {
    JK_DATA = null;
    banner('Could not load the Jamatkhana list: ' + e.message, true);
  }
  return JK_DATA;
}
// The JKs available to a Didar = the distinct JKs across the Didar's regions.
function jksForDidar(didar) {
  const out = [], seen = new Set();
  for (const R of (didar.regions || [])) {
    for (const x of ((JK_DATA && JK_DATA[R]) || [])) {
      if (seen.has(x.jk)) continue;
      seen.add(x.jk); out.push({ ...x, region: R });
    }
  }
  return out;
}
// JK -> sibling session name, for the sessions under this Didar (excluding the one being edited).
function takenByOthers(didarId, exceptSessionId) {
  const map = {};
  for (const s of EVENTS.filter(e => e.parent === didarId && e.id !== exceptSessionId)) {
    for (const jk of (s.jamatkhanas || [])) if (!(jk in map)) map[jk] = s.name;
  }
  return map;
}
function renderJkChecklist(hostId, didar, selected, exceptSessionId) {
  const host = document.getElementById(hostId);
  const sel = new Set((selected || []).map(String));
  const taken = takenByOthers(didar.id, exceptSessionId);
  const jks = jksForDidar(didar);
  if (!JK_DATA) { host.innerHTML = '<div class="jknote">Jamatkhana list unavailable — try reopening.</div>'; return; }
  const known = new Set(jks.map(x => x.jk));
  let html = jks.map(x => {
    const isTaken = !!taken[x.jk] && !sel.has(x.jk);       // taken by a sibling and not ours -> locked
    const checked = sel.has(x.jk) ? 'checked' : '';
    const note = isTaken
      ? `<span class="jktaken">in ${esc(taken[x.jk])}</span>`
      : `<span class="jkc">${x.total}${x.accepted != null ? ' · ' + x.accepted + ' accepted' : ''}</span>`;
    return `<label class="jkrow${isTaken ? ' taken' : ''}"><input type="checkbox" class="jk-cb" value="${esc(x.jk)}" ${checked} ${isTaken ? 'disabled' : ''}>`
      + `<span class="jkname">${esc(x.jk)}</span>${note}</label>`;
  }).join('');
  // Any already-mapped JK that no longer appears in the live data — keep it so editing never drops it.
  for (const jk of sel) {
    if (known.has(jk)) continue;
    html += `<label class="jkrow"><input type="checkbox" class="jk-cb" value="${esc(jk)}" checked>`
      + `<span class="jkname">${esc(jk)}</span><span class="jkmiss">not in current data</span></label>`;
  }
  host.innerHTML = html || '<div class="jknote">No Jamatkhanas found in this Didar\u2019s regions yet.</div>';
}

async function openJkModal(ctx) {
  modalCtx = ctx;
  const didar = didarById(ctx.didarId);
  if (!didar) { banner('Parent Didar not found.', true); return; }
  const dlg = document.getElementById('jkModal');
  document.getElementById('jkModalTitle').textContent =
    ctx.mode === 'edit' ? 'Jamatkhanas for this session' : 'Choose Jamatkhanas';
  document.getElementById('jkModalSub').textContent =
    `${didar.name} \u00b7 regions: ${(didar.regions || []).join(', ') || 'none'}`;
  document.getElementById('jkModalChecks').innerHTML = '<div class="jknote">Loading Jamatkhanas\u2026</div>';
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  await loadJkData();
  const selected = ctx.mode === 'edit'
    ? ((EVENTS.find(e => e.id === ctx.sessionId) || {}).jamatkhanas || [])
    : pendingJks;
  renderJkChecklist('jkModalChecks', didar, selected, ctx.mode === 'edit' ? ctx.sessionId : null);
}

async function saveJkModal() {
  const picked = [...document.querySelectorAll('#jkModalChecks .jk-cb:checked')].map(c => c.value);
  const dlg = document.getElementById('jkModal');
  if (modalCtx && modalCtx.mode === 'edit') {
    const save = document.getElementById('jkModalSave'); save.disabled = true;
    try {
      await post({ op: 'update', entry: { id: modalCtx.sessionId, jamatkhanas: picked } });
      banner('Updated Jamatkhanas.', false);
      dlg.close(); render(); fillParents();
    } catch (e) { banner('Could not save: ' + e.message, true); }
    save.disabled = false;
  } else {
    pendingJks = picked; updateJkSummary(); dlg.close();
  }
}

function updateJkSummary() {
  const el = document.getElementById('jkSummary');
  if (!el) return;
  if (!pendingJks.length) { el.textContent = 'None selected'; el.removeAttribute('title'); return; }
  el.textContent = `${pendingJks.length} selected`;
  el.title = pendingJks.join(', ');
}

function render() {
  const tb = document.getElementById('rows');
  const rows = [];
  const ds = didars();
  for (const d of ds) {
    rows.push(evRow(d, false));
    for (const s of EVENTS.filter(e => e.parent === d.id)) rows.push(evRow(s, true));
  }
  tb.innerHTML = rows.join('') || '<tr><td colspan="3" class="count">No events yet.</td></tr>';
  document.getElementById('count').textContent = `${ds.length} Didar(s) \u00b7 ${EVENTS.length} event(s) total`;
  tb.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', onAct));
}

function evRow(e, isSession) {
  const n = (e.jamatkhanas || []).length;
  const mid = isSession
    ? (n ? `${n} Jamatkhana${n === 1 ? '' : 's'}` : '<span class="jkcount">none yet</span>')
    : ((e.regions && e.regions.length) ? `<span class="regtag">Regions: ${e.regions.map(esc).join(', ')}</span>` : '<span class="jkcount">no regions set</span>');
  const active = e.active !== false;
  const nameCell = isSession
    ? `<span class="ev-session">\u21b3 ${esc(e.name)}</span>`
    : `<span class="ev-didar">${esc(e.name)}</span>`;
  const pill = active ? '' : '<span class="pill off">inactive</span>';
  return `<tr>
    <td>${nameCell}${pill}</td>
    <td>${mid}</td>
    <td><div class="actions">
      <button class="editbtn" data-act="rename" data-id="${esc(e.id)}">Rename</button>
      ${isSession ? `<button class="editbtn" data-act="jks" data-id="${esc(e.id)}">Jamatkhanas</button>`
                  : `<button class="editbtn" data-act="regions" data-id="${esc(e.id)}">Regions</button>`}
      <button class="editbtn" data-act="toggle" data-id="${esc(e.id)}">${active ? 'Deactivate' : 'Activate'}</button>
      <button class="remove" data-act="remove" data-id="${esc(e.id)}">Remove</button>
    </div></td></tr>`;
}

async function post(payload) {
  const r = await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
  EVENTS = d.events || EVENTS;
  return d;
}

async function add() {
  clearBanner();
  const name = document.getElementById('name').value.trim();
  const type = document.getElementById('type').value;
  if (!name) { banner('Enter a name.', true); return; }
  const entry = { name };
  if (type === 'session') {
    entry.parent = document.getElementById('parent').value;
    if (!entry.parent) { banner('Pick a parent Didar (create one first if there are none).', true); return; }
    entry.jamatkhanas = pendingJks;                         // chosen via the checklist
  } else {
    entry.regions = [...document.querySelectorAll('.reg-cb')].filter(c => c.checked).map(c => c.value);
  }
  const btn = document.getElementById('addBtn'); btn.disabled = true;
  try {
    await post({ op: 'add', entry });
    banner(`Added \u201c${esc(name)}\u201d.`, false);
    document.getElementById('name').value = '';
    pendingJks = []; updateJkSummary();
    document.querySelectorAll('.reg-cb').forEach(c => c.checked = false);
    render(); fillParents();
  } catch (e) { banner('Could not add: ' + e.message, true); }
  btn.disabled = false;
}

async function onAct(ev) {
  const b = ev.currentTarget;
  const id = b.dataset.id, act = b.dataset.act;
  const e = EVENTS.find(x => x.id === id);
  if (!e) return;
  clearBanner();
  try {
    if (act === 'remove') {
      if (!confirm(`Remove \u201c${e.name}\u201d?`)) return;
      await post({ op: 'remove', id });
      banner('Removed.', false);
    } else if (act === 'rename') {
      const nm = prompt('New name:', e.name);
      if (nm === null) return;
      await post({ op: 'update', entry: { id, name: nm } });
      banner('Renamed.', false);
    } else if (act === 'jks') {
      openJkModal({ mode: 'edit', sessionId: id, didarId: e.parent });   // checklist modal, not a prompt
      return;                                                            // modal handles its own save + re-render
    } else if (act === 'regions') {
      const cur = (e.regions || []).join(', ');
      const v = prompt('Regions this Didar covers (comma-separated — BC, Prairies, Edmonton):', cur);
      if (v === null) return;
      await post({ op: 'update', entry: { id, regions: v } });
      banner('Updated regions.', false);
    } else if (act === 'toggle') {
      await post({ op: 'update', entry: { id, active: e.active === false } });
      banner('Updated.', false);
    }
    render(); fillParents();
  } catch (err) { banner('Action failed: ' + err.message, true); }
}

boot();
