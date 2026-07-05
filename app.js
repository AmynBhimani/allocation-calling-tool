const AREAS = ["Safety & Flow Management","Parking & Transportation","Reception & Hospitality",
  "Seniors & Mobility","Food Services","Layout & Logistics","Registration & Access","Medical Services", "Diverse Abilities Support",
  "Finance & Procurement","Environmental Sustainability","Memorabilia & Design","Jamati Preparation"];

let DATA = [];
let resolvedThisSession = 0;
let ROLES = [];
const filters = { q:"", region:"", jk:"", area:"", group:"", recon:false, unassigned:false, leadership:false, leader:false, new:false, nobi:false };

function banner(msg, isErr) {
  const b = document.getElementById('banner');
  b.hidden = false; b.className = "banner" + (isErr ? " err" : "");
  b.innerHTML = msg;
}

async function boot() {
  // who am I + roles
  try {
    const me = await (await fetch('/.auth/me')).json();
    const cp = me && me.clientPrincipal;
    if (cp) {
      ROLES = cp.userRoles || [];
      const label = ROLES.filter(r => r !== 'anonymous' && r !== 'authenticated').join(', ') || 'no role';
      document.getElementById('whoami').innerHTML = `<b>${cp.userDetails}</b> · ${label}`;
      if (ROLES.includes('superadmin')) document.getElementById('seedBtn').hidden = false;
    }
  } catch (e) { /* SWA will have redirected if unauthorized */ }

  // selects
  ["BC","Prairies","Edmonton"].forEach(r=>{const o=document.createElement('option');o.value=r;o.textContent=r;document.getElementById('region').appendChild(o);});
  AREAS.forEach(a=>{const o=document.createElement('option');o.value=a;o.textContent=a;document.getElementById('area').appendChild(o);});

  // listeners
  document.getElementById('q').addEventListener('input',e=>{filters.q=e.target.value.toLowerCase();render();});
  document.getElementById('region').addEventListener('change',e=>{filters.region=e.target.value;filters.jk="";buildJk();render();});
  document.getElementById('jk').addEventListener('change',e=>{filters.jk=e.target.value;render();});
  document.getElementById('area').addEventListener('change',e=>{filters.area=e.target.value;render();});
  document.getElementById('groupSel').addEventListener('change',e=>{filters.group=e.target.value;render();});
  document.querySelectorAll('.chip').forEach(ch=>ch.addEventListener('click',()=>{
    const f=ch.dataset.f; filters[f]=!filters[f]; ch.setAttribute('aria-pressed',filters[f]); render();
  }));
  document.getElementById('seedBtn').addEventListener('click', seed);

  // Only the Duty Allocation Team (and admins) use this screen. Others get a friendly note,
  // not a failed data load.
  const canRecon = ROLES.includes('superadmin') || ROLES.includes('admin') || ROLES.includes('dutyteam');
  if (!canRecon) {
    if (ROLES.includes('quarterback')) { window.location.replace('/quarterback.html'); return; }
    if (ROLES.includes('caller')) { window.location.replace('/caller.html'); return; }
    const roleName = 'your role';
    banner(`This is the reconciliation screen for the Duty Allocation Team. A dedicated screen for <b>${roleName}</b> is coming — you'll be routed there once it's built.`, false);
    document.getElementById('count').textContent = '';
    return;
  }

  await load();
}

async function load() {
  document.getElementById('count').textContent = "Loading…";
  try {
    const r = await fetch('/api/volunteers');
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    DATA = d.volunteers || [];
    buildJk();
    if (!DATA.length) {
      banner(ROLES.includes('superadmin')
        ? 'No volunteers loaded yet. Click <b>Load sandbox data</b> (top right) to seed the workspace for review.'
        : 'No volunteers loaded yet. Ask a coordinator to load the data.', false);
    } else {
      document.getElementById('banner').hidden = true;
    }
    render();
  } catch (e) {
    banner('Could not load volunteers: ' + e.message, true);
    document.getElementById('count').textContent = "Load failed.";
  }
}

async function seed() {
  const btn = document.getElementById('seedBtn');
  btn.disabled = true; btn.textContent = "Loading…";
  try {
    const r = await fetch('/api/seed', { method:'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    banner(`Loaded <b>${d.total}</b> sandbox volunteers.`, false);
    await load();
  } catch (e) {
    banner('Seeding failed: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "Load sandbox data";
  }
}

function buildJk() {
  const sel = document.getElementById('jk');
  const cur = filters.jk;
  const pool = DATA.filter(v => !filters.region || v.region === filters.region);
  const jks = [...new Set(pool.map(v => v.jk))].sort();
  sel.innerHTML = '<option value="">All Jamatkhanas</option>' +
    jks.map(j => `<option value="${j}" ${j===cur?'selected':''}>${j}</option>`).join('');
}

function effectiveStatus(v){
  // Derive the true status from the record so stale stored values can't mislabel.
  if(typeof v === 'string') v = { status: v };
  if(v && v.status === 'Leadership - Do Not Allocate') return 'Leadership - Do Not Allocate';
  const claims = (v && Array.isArray(v.claims)) ? v.claims.length : 0;
  if(claims > 1) return 'In reconciliation';     // still contested -> not callable
  if(v && v.final) return 'Stable';
  return 'Unassigned';
}
function statusPill(v){
  const s = effectiveStatus(v);
  if(s === 'Leadership - Do Not Allocate') return '<span class="pill p-lead">Leadership · do not allocate</span>';
  if(s === 'Stable') return '<span class="pill p-stable">Stable · callable</span>';
  if(s === 'In reconciliation') return '<span class="pill p-recon">In reconciliation</span>';
  return '<span class="pill p-un">Unassigned</span>';
}
function matches(v){
  if(filters.q && !((v.first+" "+v.last).toLowerCase().includes(filters.q))) return false;
  if(filters.region && v.region!==filters.region) return false;
  if(filters.jk && v.jk!==filters.jk) return false;
  if(filters.area && v.final!==filters.area && v.computed!==filters.area) return false;
  if(filters.recon && effectiveStatus(v)!=="In reconciliation") return false;
  if(filters.unassigned && effectiveStatus(v)!=="Unassigned") return false;
  if(filters.leadership && effectiveStatus(v)!=="Leadership - Do Not Allocate") return false;
  if(filters.leader && !v.leader) return false;
  if(filters.new && !v.new) return false;
  if(filters.nobi && !v.no_bi) return false;
  if(filters.group && !matchesGroup(v,filters.group)) return false;
  return true;
}
// Special-group filter: IFF (interfaith list), Seniors (>65), Young (5–13). Age-based ones need an age on file.
function matchesGroup(v,g){
  if(g==="iff") return !!v.iff;
  if(g==="seniors") return v.age!=null && v.age>65;
  if(g==="young") return v.age!=null && v.age>=5 && v.age<=13;
  return true;
}

function render(){
  const tot=DATA.length;
  const stable=DATA.filter(v=>effectiveStatus(v)==="Stable").length;
  const recon=DATA.filter(v=>effectiveStatus(v)==="In reconciliation").length;
  const un=DATA.filter(v=>effectiveStatus(v)==="Unassigned").length;
  const lead=DATA.filter(v=>effectiveStatus(v)==="Leadership - Do Not Allocate").length;
  document.getElementById('kpis').innerHTML = [
    ['',tot,'Total volunteers','var(--ink)'],
    ['callable',stable,'Stable · callable now','var(--stable)'],
    ['recon',recon,'In reconciliation','var(--recon)'],
    ['un',un,'Unassigned','var(--un)'],
    ['lead',lead,'Leadership · do not allocate','var(--lead)'],
  ].map(([cls,n,l,col])=>`<div class="kpi ${cls}"><div class="n">${n.toLocaleString()}</div>
    <div class="l">${l}</div><div class="bar"><i style="width:${tot?Math.round(n/tot*100):0}%;background:${col}"></i></div></div>`).join('');

  document.getElementById('resolved').innerHTML = resolvedThisSession
    ? `<b>${resolvedThisSession}</b> made callable this session` : '';

  const list = DATA.filter(matches);
  const rows = document.getElementById('rows');
  if(!list.length){
    rows.innerHTML = tot
      ? '<tr><td colspan="6"><div class="empty">No volunteers match these filters. Try clearing a chip.</div></td></tr>'
      : '<tr><td colspan="6"><div class="empty">No volunteers loaded.</div></td></tr>';
    document.getElementById('count').textContent = tot ? 'No matches.' : '';
    return;
  }
  rows.innerHTML = list.map(v=>{
    const badges=[];
    if(v.affinity) badges.push('<span class="badge b-aff">Affinity</span>');
    if(v.leader) badges.push('<span class="badge b-lead">Leader</span>');
    if(v.iff) badges.push('<span class="badge b-iff">IFF</span>');
    if(v.new) badges.push('<span class="badge b-new">New</span>');
    if(v.no_bi) badges.push('<span class="badge b-nobi">No BI acct</span>');
    const computed = v.computed ? `<span class="area-cell">${v.computed}</span>` : '<span class="area-none">no area selected</span>';
    const conflict = (v.claims&&v.claims.length) ? `<div class="conflict">Claimed by: ${v.claims.join(' · ')}</div>` : '';
    const isLead = v.status==="Leadership - Do Not Allocate";
    const unset = !v.final;
    const needsChoice = (v.status==="In reconciliation" || v.status==="Unassigned" || (v.claims&&v.claims.length)) && !isLead;
    const preselect = needsChoice ? "" : (v.final||"");
    const opts = [`<option value="" ${preselect===""&&!isLead?'selected':''}>— choose —</option>`]
      .concat(AREAS.map(a=>`<option value="${a}" ${preselect===a?'selected':''}>${a}</option>`))
      .concat([`<option value="__leadership__" ${isLead?'selected':''}>⚑ Leadership – Do Not Allocate</option>`]).join('');
    return `<tr data-id="${v.id}" class="${v.status==='In reconciliation'?'recon-row':''}${isLead?' lead-row':''}">
      <td><div class="name">${v.first} ${v.last}</div><div class="sub">#${v.id}${v.age!=null?' · age '+v.age:''}</div>${conflict}</td>
      <td class="hide-sm"><span class="sub">${v.jk}</span></td>
      <td>${computed}</td>
      <td><div class="badges">${badges.join('')||'<span class="sub">—</span>'}</div></td>
      <td>${statusPill(v)}</td>
      <td><select class="final ${unset&&!isLead?'unset':''}" data-id="${v.id}" data-region="${v.region}">${opts}</select></td>
    </tr>`;
  }).join('');
  rows.querySelectorAll('select.final').forEach(sel=>sel.addEventListener('change',onFinalChange));
  document.getElementById('count').textContent = `Showing ${list.length} of ${tot} volunteers`;
}

async function onFinalChange(e){
  const sel = e.target;
  const region = sel.dataset.region;
  const v = DATA.find(x=>String(x.id)===String(sel.dataset.id));
  const id = v ? v.id : sel.dataset.id;
  const val = sel.value;
  const wasNotCallable = v.status!=="Stable";
  sel.disabled = true;
  try {
    const payload = (val === "__leadership__")
      ? { user_id:id, region, op:"leadership" }
      : { user_id:id, region, op:"final_area", final_area: val === "" ? null : val };
    const r = await fetch('/api/volunteers', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
    Object.assign(v, d.volunteer); // server is source of truth
    if (v.status==="Stable" && wasNotCallable) resolvedThisSession++;
    render();
    const tr=document.querySelector(`tr[data-id="${id}"]`);
    if(tr){ tr.classList.add('flash'); setTimeout(()=>tr.classList.remove('flash'),1000); }
  } catch (err) {
    banner('Could not save change: ' + err.message, true);
    sel.disabled = false;
  }
}

boot();
