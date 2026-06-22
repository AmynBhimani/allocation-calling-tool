let META = { roles: [], regions: [], areas: [] };

function banner(msg, isErr) {
  const b = document.getElementById('banner');
  b.hidden = false; b.className = "banner" + (isErr ? " err" : "");
  b.innerHTML = msg;
}
function clearBanner(){ document.getElementById('banner').hidden = true; }

const ROLE_LABEL = { admin: "Admin", dutyteam: "Duty Allocation Team", quarterback: "Quarterback", caller: "Caller" };
const ROLE_HINT = {
  admin: "Manages everything within their event's regions. Tag them to an event.",
  dutyteam: "Reconciliation within their event's regions. Tag them to an event.",
  quarterback: "Manages area(s) within their event's regions. Event and at least one area required.",
  caller: "Makes calls for area(s) within their event's regions. Event and at least one area required.",
};

async function boot() {
  try {
    const me = await (await fetch('/.auth/me')).json();
    const cp = me && me.clientPrincipal;
    if (cp) document.getElementById('whoami').innerHTML = `<b>${cp.userDetails}</b>`;
  } catch (e) {}

  document.getElementById('role').addEventListener('change', onRoleChange);
  document.getElementById('addBtn').addEventListener('click', add);

  await load();
  onRoleChange();
}

function fillSelect(sel, items) {
  sel.innerHTML = '<option value="">—</option>' + items.map(x => `<option value="${x}">${x}</option>`).join('');
}
function buildAreaChecks(areas) {
  document.getElementById('areaChecks').innerHTML = areas.map((a, i) =>
    `<label><input type="checkbox" class="area-cb" value="${a}"> ${a}</label>`).join('');
}
function selectedAreas() {
  return [...document.querySelectorAll('.area-cb')].filter(c => c.checked).map(c => c.value);
}
function clearAreaChecks() {
  document.querySelectorAll('.area-cb').forEach(c => c.checked = false);
}

function onRoleChange() {
  const role = document.getElementById('role').value;
  const needsArea = role === 'quarterback' || role === 'caller';
  document.getElementById('eventField').classList.remove('hide'); // every role is event-scoped now
  document.getElementById('areaField').classList.toggle('hide', !needsArea);
  document.getElementById('roleHint').textContent = ROLE_HINT[role] || "";
}
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fillEventSelect(events){
  const sel=document.getElementById('event');
  sel.innerHTML='<option value="">—</option>'+(events||[]).map(e=>
    `<option value="${esc(e.id)}">${esc(e.name)}${e.regions&&e.regions.length?` (${esc(e.regions.join(', '))})`:''}</option>`).join('');
}
function eventNameOf(id){ const e=(META.events||[]).find(x=>x.id===id); return e?e.name:(id||''); }

async function load() {
  document.getElementById('count').textContent = "Loading…";
  try {
    const r = await fetch('/api/roleadmin');
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || ("HTTP " + r.status));
    const d = await r.json();
    META = d.meta || META;
    fillEventSelect(META.events);
    buildAreaChecks(META.areas);
    render(d.assignments || []);
    clearBanner();
  } catch (e) {
    banner('Could not load team list: ' + e.message, true);
    document.getElementById('count').textContent = "Load failed.";
  }
}

function render(list) {
  const rows = document.getElementById('rows');
  if (!list.length) {
    document.getElementById('count').textContent = '0 assignments';
    rows.innerHTML = '<tr><td colspan="4"><div class="empty">No one added yet. Add your first team member above.</div></td></tr>';
    return;
  }
  // Collapse the per-region rows back into one line per (email, role, event).
  const groups = {};
  for (const a of list) {
    const key = [String(a.email).toLowerCase(), a.role, a.event || ''].join('|||');
    const g = groups[key] || (groups[key] = { email: a.email, role: a.role, event: a.event || '', regions: new Set(), areas: new Set() });
    if (a.region) g.regions.add(a.region);
    if (a.area) g.areas.add(a.area);
  }
  const arr = Object.values(groups);
  const order = ["admin", "dutyteam", "quarterback", "caller"];
  arr.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || (a.event || '').localeCompare(b.event || '') || a.email.localeCompare(b.email));
  document.getElementById('count').textContent = `${arr.length} assignment${arr.length === 1 ? "" : "s"}`;
  rows.innerHTML = arr.map(g => {
    const evName = g.event ? esc(eventNameOf(g.event)) : '<span class="scope-txt">no event</span>';
    const areaTxt = g.areas.size ? ' · ' + esc([...g.areas].join(', ')) : '';
    const payload = encodeURIComponent(JSON.stringify({ email: g.email, role: g.role, event: g.event }));
    return `<tr>
      <td>${esc(g.email)}</td>
      <td><span class="role-pill r-${g.role}">${ROLE_LABEL[g.role] || g.role}</span></td>
      <td>${evName}${areaTxt}</td>
      <td style="text-align:right"><button class="remove" data-entry="${payload}">Remove</button></td>
    </tr>`;
  }).join('');
  rows.querySelectorAll('.remove').forEach(b => b.addEventListener('click', () => remove(JSON.parse(decodeURIComponent(b.dataset.entry)))));
}

async function add() {
  const role = document.getElementById('role').value;
  const entry = {
    email: document.getElementById('email').value.trim(),
    role,
    event: document.getElementById('event').value,
    areas: selectedAreas(),
  };
  const btn = document.getElementById('addBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/roleadmin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'add', entry })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    const dupeNote = d.dupes ? ` (${d.dupes} already existed)` : '';
    banner(`Added <b>${esc(entry.email)}</b> as ${ROLE_LABEL[role]}${d.eventName ? ` — ${esc(d.eventName)}` : ''}.${dupeNote}`, false);
    document.getElementById('email').value = '';
    document.getElementById('role').value = 'admin';
    document.getElementById('event').value = '';
    clearAreaChecks();
    onRoleChange();
    render(d.assignments);
  } catch (e) {
    banner('Could not add: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function remove(entry) {
  if (!confirm(`Remove ${entry.email} (${ROLE_LABEL[entry.role] || entry.role})?`)) return;
  try {
    const r = await fetch('/api/roleadmin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'remove', entry })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    banner(`Removed <b>${entry.email}</b>.`, false);
    render(d.assignments);
  } catch (e) {
    banner('Could not remove: ' + e.message, true);
  }
}

boot();
