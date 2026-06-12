let META = { roles: [], regions: [], areas: [] };

function banner(msg, isErr) {
  const b = document.getElementById('banner');
  b.hidden = false; b.className = "banner" + (isErr ? " err" : "");
  b.innerHTML = msg;
}
function clearBanner(){ document.getElementById('banner').hidden = true; }

const ROLE_LABEL = { admin: "Admin", dutyteam: "Duty Allocation Team", quarterback: "Quarterback", caller: "Caller" };
const ROLE_HINT = {
  admin: "Global access: the iVol-input report and syncs. No scope needed.",
  dutyteam: "Reconciliation. Region is optional — leave blank for all regions.",
  quarterback: "Manages one area × region. Region and area are required.",
  caller: "Makes calls for one area × region. Region and area are required.",
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

function onRoleChange() {
  const role = document.getElementById('role').value;
  const needsScope = role === 'quarterback' || role === 'caller';
  const showRegion = needsScope || role === 'dutyteam';
  document.getElementById('regionField').classList.toggle('hide', !showRegion);
  document.getElementById('areaField').classList.toggle('hide', !needsScope);
  document.getElementById('roleHint').textContent = ROLE_HINT[role] || "";
}

async function load() {
  document.getElementById('count').textContent = "Loading…";
  try {
    const r = await fetch('/api/roleadmin');
    if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || ("HTTP " + r.status));
    const d = await r.json();
    META = d.meta || META;
    fillSelect(document.getElementById('region'), META.regions);
    fillSelect(document.getElementById('area'), META.areas);
    render(d.assignments || []);
    clearBanner();
  } catch (e) {
    banner('Could not load team list: ' + e.message, true);
    document.getElementById('count').textContent = "Load failed.";
  }
}

function render(list) {
  const rows = document.getElementById('rows');
  document.getElementById('count').textContent = `${list.length} assignment${list.length === 1 ? "" : "s"}`;
  if (!list.length) {
    rows.innerHTML = '<tr><td colspan="4"><div class="empty">No one added yet. Add your first team member above.</div></td></tr>';
    return;
  }
  // group by role for readability
  const order = ["admin", "dutyteam", "quarterback", "caller"];
  const sorted = [...list].sort((a, b) =>
    order.indexOf(a.role) - order.indexOf(b.role) || (a.region||"").localeCompare(b.region||"") ||
    (a.area||"").localeCompare(b.area||"") || a.email.localeCompare(b.email));
  rows.innerHTML = sorted.map(a => {
    const scope = [a.region, a.area].filter(Boolean).join(" · ") || '<span class="scope-txt">—</span>';
    const entry = encodeURIComponent(JSON.stringify(a));
    return `<tr>
      <td>${a.email}</td>
      <td><span class="role-pill r-${a.role}">${ROLE_LABEL[a.role] || a.role}</span></td>
      <td>${scope}</td>
      <td style="text-align:right"><button class="remove" data-entry="${entry}">Remove</button></td>
    </tr>`;
  }).join('');
  rows.querySelectorAll('.remove').forEach(b => b.addEventListener('click', () => remove(JSON.parse(decodeURIComponent(b.dataset.entry)))));
}

async function add() {
  const role = document.getElementById('role').value;
  const entry = {
    email: document.getElementById('email').value.trim(),
    role,
    region: document.getElementById('region').value,
    area: document.getElementById('area').value,
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
    document.getElementById('email').value = '';
    banner(`Added <b>${entry.email}</b> as ${ROLE_LABEL[role]}.`, false);
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
