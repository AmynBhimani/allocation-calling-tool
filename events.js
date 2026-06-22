let EVENTS = [];

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
  document.getElementById('addBtn').addEventListener('click', add);
  await load();
  onType();
}

function onType() {
  const isSession = document.getElementById('type').value === 'session';
  document.getElementById('parentField').classList.toggle('hide', !isSession);
  document.getElementById('jkField').classList.toggle('hide', !isSession);
  document.getElementById('regionsField').classList.toggle('hide', isSession); // regions are a Didar property
}
function didars() { return EVENTS.filter(e => !e.parent); }
function fillParents() {
  const sel = document.getElementById('parent');
  const ds = didars();
  sel.innerHTML = ds.length
    ? ds.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')
    : '<option value="">(create a Didar first)</option>';
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

function render() {
  const tb = document.getElementById('rows');
  const rows = [];
  const ds = didars();
  for (const d of ds) {
    rows.push(evRow(d, false));
    for (const s of EVENTS.filter(e => e.parent === d.id)) rows.push(evRow(s, true));
  }
  tb.innerHTML = rows.join('') || '<tr><td colspan="3" class="count">No events yet.</td></tr>';
  document.getElementById('count').textContent = `${ds.length} Didar(s) · ${EVENTS.length} event(s) total`;
  tb.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', onAct));
}

function evRow(e, isSession) {
  const n = (e.jamatkhanas || []).length;
  const mid = isSession
    ? (n ? `${n} Jamatkhana${n === 1 ? '' : 's'}` : '<span class="jkcount">none yet</span>')
    : ((e.regions && e.regions.length) ? `<span class="regtag">Regions: ${e.regions.map(esc).join(', ')}</span>` : '<span class="jkcount">no regions set</span>');
  const active = e.active !== false;
  const nameCell = isSession
    ? `<span class="ev-session">↳ ${esc(e.name)}</span>`
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
    entry.jamatkhanas = document.getElementById('jks').value;
  } else {
    entry.regions = [...document.querySelectorAll('.reg-cb')].filter(c => c.checked).map(c => c.value);
  }
  const btn = document.getElementById('addBtn'); btn.disabled = true;
  try {
    await post({ op: 'add', entry });
    banner(`Added “${esc(name)}”.`, false);
    document.getElementById('name').value = '';
    document.getElementById('jks').value = '';
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
      if (!confirm(`Remove “${e.name}”?`)) return;
      await post({ op: 'remove', id });
      banner('Removed.', false);
    } else if (act === 'rename') {
      const nm = prompt('New name:', e.name);
      if (nm === null) return;
      await post({ op: 'update', entry: { id, name: nm } });
      banner('Renamed.', false);
    } else if (act === 'jks') {
      const cur = (e.jamatkhanas || []).join('\n');
      const v = prompt('Participating Jamatkhanas (one per line or comma-separated):', cur);
      if (v === null) return;
      await post({ op: 'update', entry: { id, jamatkhanas: v } });
      banner('Updated Jamatkhanas.', false);
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
