let DATA = [];        // pool volunteers (slim)
let RESOLVED = [];    // settled by a caller (accepted / withdrew)
let DUTY_NAMES = {};  // area -> [duty names], from /api/duties
let SCOPES = [];      // [{area, region}]
let CALLERS = [];     // [{email, area, region}]
let ROLES = [];
const selected = new Set();
const filters = { q:"", jk:"", scope:"", area:"", caller:"", unassignedOnly:false, assignedOnly:false, leader:false, nobi:false, referred:false };
let qtab = "pool";          // "pool" | "done"
let doneQuery = "";         // search text for the Completed tab

function switchTab(t){
  qtab = t;
  document.getElementById('poolView').hidden = (t!=='pool');
  document.getElementById('doneView').hidden = (t!=='done');
  document.getElementById('tabPool').setAttribute('aria-pressed', String(t==='pool'));
  document.getElementById('tabDone').setAttribute('aria-pressed', String(t==='done'));
  if(t==='done') renderResolved();
}

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }
const scopeKey = s => `${s.region} · ${s.area}`;

async function boot(){
  try{
    const me = await (await fetch('/.auth/me')).json();
    const cp = me && me.clientPrincipal;
    if(cp){ ROLES = cp.userRoles||[];
      document.getElementById('whoami').innerHTML = `<b>${cp.userDetails}</b>`;
    }
  }catch(e){}

  document.getElementById('q').addEventListener('input',e=>{filters.q=e.target.value.toLowerCase();render();});
  document.getElementById('jk').addEventListener('change',e=>{filters.jk=e.target.value;render();});
  document.getElementById('areaSel').addEventListener('change',e=>{filters.area=e.target.value;render();});
  document.getElementById('scopeSel').addEventListener('change',e=>{filters.scope=e.target.value;filters.jk="";buildJk();render();});
  document.getElementById('callerFilter').addEventListener('change',e=>{filters.caller=e.target.value;render();});
  document.getElementById('clearFilters').addEventListener('click',clearFilters);
  document.querySelectorAll('.chip').forEach(ch=>ch.addEventListener('click',()=>{
    const f=ch.dataset.f; filters[f]=!filters[f]; ch.setAttribute('aria-pressed',filters[f]);
    if(f==='unassignedOnly'&&filters[f]){filters.assignedOnly=false;document.querySelector('[data-f=assignedOnly]').setAttribute('aria-pressed','false');}
    if(f==='assignedOnly'&&filters[f]){filters.unassignedOnly=false;document.querySelector('[data-f=unassignedOnly]').setAttribute('aria-pressed','false');}
    render();
  }));
  document.getElementById('cbAll').addEventListener('change',e=>toggleAllVisible(e.target.checked));
  document.getElementById('selectAllFiltered').addEventListener('click',()=>toggleAllVisible(true));
  document.getElementById('clearSel').addEventListener('click',()=>{selected.clear();render();});
  document.getElementById('assignBtn').addEventListener('click',assign);
  document.getElementById('unassignBtn').addEventListener('click',unassign);
  document.getElementById('callerSel').addEventListener('change',updateActionBar);
  document.getElementById('toggleAddCaller').addEventListener('click',()=>{const a=document.getElementById('addCaller');a.hidden=!a.hidden;});
  document.getElementById('saveCaller').addEventListener('click',saveCaller);
  document.getElementById('tabPool').addEventListener('click',()=>switchTab('pool'));
  document.getElementById('tabDone').addEventListener('click',()=>switchTab('done'));
  document.getElementById('doneSearch').addEventListener('input',e=>{ doneQuery=e.target.value.toLowerCase(); renderResolved(); });

  await load();
}

async function load(){
  document.getElementById('count').textContent="Loading…";
  try{
    const r = await fetch('/api/assign');
    if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || ("HTTP "+r.status));
    const d = await r.json();
    DATA = d.volunteers||[]; RESOLVED = d.resolved||[]; SCOPES = d.scopes||[]; CALLERS = d.callers||[];
    try{
      const dr = await fetch('/api/duties');
      if(dr.ok){ const dd=await dr.json(); DUTY_NAMES={};
        (dd.duties||[]).forEach(x=>{ (DUTY_NAMES[x.area]=DUTY_NAMES[x.area]||[]).push(x.name); });
        Object.keys(DUTY_NAMES).forEach(a=>DUTY_NAMES[a].sort((p,q)=>p.localeCompare(q))); }
    }catch(e){}
    buildScopeSelect(); buildCallerSelect(); buildCallerFilter(); buildCallerScopes(); buildAreaSelect(); buildJk();
    clearBanner(); render(); renderResolved();
  }catch(e){
    banner('Could not load your pool: '+e.message, true);
    document.getElementById('count').textContent="Load failed.";
  }
}

function buildScopeSelect(){
  const sel=document.getElementById('scopeSel');
  const keys=[...new Set(SCOPES.map(scopeKey))].sort();
  sel.innerHTML='<option value="">All my areas</option>'+keys.map(k=>`<option value="${k}">${k}</option>`).join('');
}
function buildCallerSelect(){
  const sel=document.getElementById('callerSel');
  const seen=new Set(); const opts=[];
  for(const c of CALLERS){ if(seen.has(c.email))continue; seen.add(c.email); opts.push(`<option value="${c.email}">${c.email}</option>`); }
  sel.innerHTML='<option value="">'+(opts.length?'Choose a caller…':'No callers yet — add one')+'</option>'+opts.join('');
}
function buildCallerScopes(){
  // checkboxes of the QB's own area×region scopes, for adding a caller
  const box=document.getElementById('callerScopes');
  box.innerHTML = SCOPES.map((s,i)=>`<label><input type="checkbox" class="acscope" data-area="${s.area}" data-region="${s.region}"> ${scopeKey(s)}</label>`).join('')
    || '<span class="sub">You have no areas assigned yet.</span>';
}
function buildCallerFilter(){
  const sel=document.getElementById('callerFilter');
  const seen=new Set(); const opts=[];
  for(const c of CALLERS){ if(seen.has(c.email))continue; seen.add(c.email); opts.push(`<option value="${c.email}" ${filters.caller===c.email?'selected':''}>${c.email}</option>`); }
  sel.innerHTML='<option value="">Any caller</option>'+opts.join('');
}
function clearFilters(){
  filters.q=""; filters.jk=""; filters.scope=""; filters.area=""; filters.caller="";
  filters.unassignedOnly=false; filters.assignedOnly=false; filters.leader=false; filters.nobi=false; filters.referred=false;
  document.getElementById('q').value=""; document.getElementById('scopeSel').value=""; document.getElementById('callerFilter').value="";
  const aSel=document.getElementById('areaSel'); if(aSel) aSel.value="";
  document.querySelectorAll('.chip').forEach(ch=>ch.setAttribute('aria-pressed','false'));
  buildJk(); render();
}
function buildAreaSelect(){
  const sel=document.getElementById('areaSel');
  const areas=[...new Set(DATA.map(v=>v.final).filter(Boolean))].sort();
  if(filters.area && !areas.includes(filters.area)) filters.area="";   // stale area — clear it
  const cur=filters.area;
  sel.innerHTML='<option value="">All areas</option>'+areas.map(a=>`<option value="${a}" ${a===cur?'selected':''}>${a}</option>`).join('');
}
function buildJk(){
  const sel=document.getElementById('jk');
  const pool=DATA.filter(v=>!filters.scope || scopeKey({area:v.final,region:v.region})===filters.scope);
  const jks=[...new Set(pool.map(v=>v.jk))].sort();
  if(filters.jk && !jks.includes(filters.jk)) filters.jk="";   // stale JK from a prior scope — clear it
  const cur=filters.jk;
  sel.innerHTML='<option value="">All Jamatkhanas</option>'+jks.map(j=>`<option value="${j}" ${j===cur?'selected':''}>${j}</option>`).join('');
}

function matches(v){
  if(filters.scope && scopeKey({area:v.final,region:v.region})!==filters.scope) return false;
  if(filters.area && v.final!==filters.area) return false;
  if(filters.q && !((v.first+" "+v.last).toLowerCase().includes(filters.q))) return false;
  if(filters.jk && v.jk!==filters.jk) return false;
  if(filters.unassignedOnly && v.assigned) return false;
  if(filters.assignedOnly && !v.assigned) return false;
  if(filters.leader && !v.leader) return false;
  if(filters.nobi && !v.no_bi) return false;
  if(filters.referred && !v.referred_from) return false;
  if(filters.caller && v.assigned!==filters.caller) return false;
  return true;
}

let resolvedSel = null;
function renderResolved(){
  document.getElementById('doneN').textContent = RESOLVED.length ? '('+RESOLVED.length+')' : '';
  const card=document.getElementById('resolvedCard');
  const empty=document.getElementById('doneEmpty');
  if(!RESOLVED.length){ card.style.display='none'; empty.style.display=''; resolvedSel=null; return; }
  card.style.display=''; empty.style.display='none';
  const q=doneQuery.trim();
  const shown=RESOLVED.filter(v=>!q || ((v.first+' '+v.last).toLowerCase().includes(q)));
  if(resolvedSel && !shown.some(v=>String(v.id)===String(resolvedSel))) resolvedSel=null;
  const list=document.getElementById('resolvedList');
  list.innerHTML = shown.length ? shown.map(v=>{
    const out=v.outcome==='Accepted'?'Accepted':'Withdrew';
    const cls=v.outcome==='Accepted'?'ok':'wd';
    const sel=String(resolvedSel)===String(v.id)?'sel':'';
    return `<button class="rqitem ${sel}" data-id="${v.id}" data-region="${esc(v.region)}">
      <span class="rq-name">${esc(v.first)} ${esc(v.last)}</span>
      <span class="rq-meta">${esc(v.final||'\u2014')} \u00b7 <span class="rq-out ${cls}">${out}</span></span>
    </button>`;
  }).join('') : '<div class="rd-empty" style="padding:14px">No matches.</div>';
  list.querySelectorAll('.rqitem').forEach(b=>b.addEventListener('click',()=>{ resolvedSel=b.dataset.id; renderResolved(); }));
  document.getElementById('resolvedCount').textContent = q ? `${shown.length} of ${RESOLVED.length}` : `${RESOLVED.length} completed`;
  const detail=document.getElementById('resolvedDetail');
  if(resolvedSel) showResolvedDetail(resolvedSel);
  else detail.innerHTML='<div class="rd-empty">Select someone to see their call record.</div>';
}
function showResolvedDetail(id){
  const v=RESOLVED.find(x=>String(x.id)===String(id)); if(!v) return;
  const out=v.outcome==='Accepted'?'Accepted':'Withdrew';
  const when=v.when?new Date(v.when).toLocaleString():'';
  const badges=[];
  if(v.leader) badges.push('<span class="badge b-lead">Team Lead</span>');
  if(v.affinity) badges.push('<span class="badge b-aff">Affinity</span>');
  if(v.referred_from) badges.push(`<span class="badge b-aff">Referred from ${esc(v.referred_from)}</span>`);
  const rows=[
    ['Area', esc(v.final||'\u2014')],
    ['Outcome', out + (when?` <span class="sub">\u00b7 ${esc(when)}</span>`:'') + (v.confirmed?' <span class="sub">\u00b7 self-confirmed</span>':'')],
    ['Caller', v.assigned?esc(v.assigned):'\u2014'],
  ];
  if(v.duty) rows.push(['Pre-assigned', esc(v.duty)]);
  if(v.note) rows.push(['Note', esc(v.note)]);
  const eas=(v.event_assignments||[]);
  const dutiesHtml = eas.length
    ? `<div class="rd-section"><h4>Events &amp; duties of interest</h4>${eas.map(a=>{
        const ds=(a.candidate_duties||[]).map(esc).join(', ') || 'duty to be assigned';
        return `<div class="rd-e"><b>${esc(a.eventName||a.event)}</b> \u2014 ${ds}</div>`;
      }).join('')}</div>`
    : '';
  const logHtml = (v.log&&v.log.length)
    ? `<div class="rd-section"><h4>Call history</h4>${v.log.map(e=>`<div class="rd-e"><span class="sub">${new Date(e.ts).toLocaleString()}</span> \u2014 ${esc(e.outcome)}${e.note?': '+esc(e.note):''}</div>`).join('')}</div>`
    : '';
  document.getElementById('resolvedDetail').innerHTML=`
    <div class="rd-head"><div class="rd-name">${esc(v.first)} ${esc(v.last)}</div><div class="sub">#${v.id} \u00b7 ${esc(v.jk)}</div></div>
    ${badges.length?`<div class="badge-row" style="margin-bottom:8px">${badges.join(' ')}</div>`:''}
    ${rows.map(r=>`<div class="rd-row"><span class="rd-k">${r[0]}</span><span class="rd-v">${r[1]}</span></div>`).join('')}
    ${dutiesHtml}
    ${logHtml}
    <button class="btn commit" id="rdReopen" data-id="${v.id}" data-region="${esc(v.region)}">Re-open</button>`;
  document.getElementById('rdReopen').addEventListener('click',()=>reopenResolved(v.id, v.region));
}

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function dutyCell(v){
  const opts=DUTY_NAMES[v.final]||[];
  if(!opts.length) return '<span class="sub">—</span>';
  const cur=v.duty||'';
  return `<select class="dutysel" data-id="${v.id}" data-region="${esc(v.region)}">
    <option value="">— none —</option>
    ${opts.map(d=>`<option value="${esc(d)}" ${d===cur?'selected':''}>${esc(d)}</option>`).join('')}
  </select>`;
}
async function setDuty(id, region, duty){
  const idVal = isNaN(Number(id)) ? id : Number(id);
  try{
    const r=await fetch('/api/assign',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({op:'set_duty',region,user_id:idVal,duty})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
    const v=DATA.find(x=>String(x.id)===String(id)); if(v) v.duty=duty||null;
  }catch(e){ banner('Could not save duty: '+e.message, true); }
}
async function reopenResolved(id, region){
  const idVal = isNaN(Number(id)) ? id : Number(id);
  if(!confirm('Re-open this volunteer? They go back to the assignable pool, unassigned.')) return;
  try{
    const r=await fetch('/api/assign',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({op:'reopen',region,user_ids:[idVal]})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
    banner('Re-opened — back in the pool.', false);
    await load();
  }catch(e){ banner('Could not re-open: '+e.message, true); }
}

function render(){
  const tot=DATA.length;
  const assigned=DATA.filter(v=>v.assigned).length;
  document.getElementById('kpis').innerHTML=[
    ['',tot,'In your pool','var(--ink)'],
    ['callable',assigned,'Assigned','var(--stable)'],
    ['un',tot-assigned,'Unassigned','var(--un)'],
  ].map(([cls,n,l,col])=>`<div class="kpi ${cls}"><div class="n">${n.toLocaleString()}</div>
    <div class="l">${l}</div><div class="bar"><i style="width:${tot?Math.round(n/tot*100):0}%;background:${col}"></i></div></div>`).join('');

  const list=DATA.filter(matches);
  const rows=document.getElementById('rows');
  if(!list.length){
    rows.innerHTML=`<tr><td colspan="6"><div class="empty">${tot?'No volunteers match these filters.':'No callable volunteers in your pool yet. Once reconciliation marks people in your area(s) callable, they appear here.'}</div></td></tr>`;
    document.getElementById('count').textContent = tot?'No matches.':'';
    updateActionBar(); return;
  }
  rows.innerHTML=list.map(v=>{
    const badges=[];
    if(v.leader) badges.push('<span class="badge b-lead">Team Lead</span>');
    if(v.affinity) badges.push('<span class="badge b-aff">Affinity</span>');
    if(v.new) badges.push('<span class="badge b-new">New</span>');
    if(v.no_bi) badges.push('<span class="badge b-nobi">No BI acct</span>');
    if(v.dup) badges.push('<span class="badge b-dup">Possible duplicate</span>');
    if(v.referred_from) badges.push(`<span class="badge b-aff">Referred from ${v.referred_from}</span>`);
    const checked = selected.has(v.id)?'checked':'';
    const assignedCell = v.assigned ? `<span class="assigned-tag">${v.assigned}</span>` : '<span class="unassigned-tag">— unassigned —</span>';
    return `<tr data-id="${v.id}">
      <td class="cbcol"><input type="checkbox" class="rowcb" data-id="${v.id}" data-region="${v.region}" ${checked}></td>
      <td><div class="name">${v.first} ${v.last}</div><div class="sub">#${v.id} · ${v.jk}</div></td>
      <td><span class="area-cell">${v.final||'—'}</span></td>
      <td>${dutyCell(v)}</td>
      <td><div class="badges">${badges.join('')||'<span class="sub">—</span>'}</div></td>
      <td>${assignedCell}</td>
    </tr>`;
  }).join('');
  rows.querySelectorAll('.rowcb').forEach(cb=>cb.addEventListener('change',()=>{
    const id=+cb.dataset.id; if(cb.checked) selected.add(id); else selected.delete(id); updateActionBar();
  }));
  rows.querySelectorAll('.dutysel').forEach(s=>s.addEventListener('change',()=>setDuty(s.dataset.id, s.dataset.region, s.value)));
  document.getElementById('count').textContent=`Showing ${list.length} of ${tot} · ${selected.size} selected`;
  document.getElementById('poolN').textContent = DATA.length ? '('+DATA.length+')' : '';
  updateActionBar();
}

function visibleList(){ return DATA.filter(matches); }
function toggleAllVisible(on){
  const vis=visibleList();
  if(on) vis.forEach(v=>selected.add(v.id)); else vis.forEach(v=>selected.delete(v.id));
  render();
}
function updateActionBar(){
  const n=selected.size;
  document.getElementById('selcount').textContent=`${n} selected`;
  document.getElementById('actionbar').classList.toggle('idle', n===0);
  const caller=document.getElementById('callerSel').value;
  document.getElementById('assignBtn').disabled = n===0 || !caller;
  document.getElementById('unassignBtn').disabled = n===0;
  document.getElementById('cbAll').checked = n>0 && visibleList().every(v=>selected.has(v.id));
}

function selectedByRegion(){
  const byR={};
  for(const v of DATA){ if(selected.has(v.id)){ (byR[v.region]=byR[v.region]||[]).push(v.id); } }
  return byR;
}

function callerScopeSet(email){
  return new Set(CALLERS.filter(c=>c.email===email).map(c=>`${c.region}|||${c.area}`));
}
async function assign(){
  const caller=document.getElementById('callerSel').value;
  if(!caller || !selected.size) return;
  // a volunteer can only go to a caller whose area×region covers them
  const cs=callerScopeSet(caller);
  const out=[...selected].map(id=>DATA.find(v=>v.id===id)).filter(v=>v && !cs.has(`${v.region}|||${v.final}`));
  if(out.length){
    if(!confirm(`${out.length} of the selected volunteers are outside ${caller}'s assigned lists and will be skipped. Assign the rest?`)) return;
  }
  await doAction('assign', caller);
}
async function unassign(){
  if(!selected.size) return;
  if(!confirm(`Unassign ${selected.size} volunteer(s)?`)) return;
  await doAction('unassign', null);
}
async function doAction(op, caller){
  const byR=selectedByRegion();
  document.getElementById('assignBtn').disabled=true; document.getElementById('unassignBtn').disabled=true;
  try{
    let done=0, outScope=0;
    for(const region of Object.keys(byR)){
      const reqBody={op,region,user_ids:byR[region],caller_email:caller};
      if(op==='assign'){
        const duties={}; byR[region].forEach(id=>{ const v=DATA.find(x=>String(x.id)===String(id)); if(v&&v.duty) duties[id]=v.duty; });
        reqBody.duties=duties;   // optional pre-assigned duty per volunteer
      }
      const r=await fetch('/api/assign',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(reqBody)});
      const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
      done+=d.done||0; outScope+=d.outOfCallerScope||0;
    }
    const tail = outScope?` (${outScope} skipped — outside ${caller}'s lists)`:'';
    banner(op==='assign'?`Assigned <b>${done}</b> volunteer(s) to ${caller}.${tail}`:`Unassigned <b>${done}</b> volunteer(s).`, false);
    selected.clear();
    await load();
  }catch(e){ banner('Action failed: '+e.message, true); updateActionBar(); }
}

async function saveCaller(){
  const email=document.getElementById('callerEmail').value.trim();
  const areas=[...document.querySelectorAll('.acscope')].filter(c=>c.checked);
  if(!email){ banner('Enter the caller\u2019s email.', true); return; }
  if(!areas.length){ banner('Pick at least one of your areas for this caller.', true); return; }
  // group chosen scopes by region (roleadmin add takes one region + areas[])
  const byRegion={};
  areas.forEach(c=>{ (byRegion[c.dataset.region]=byRegion[c.dataset.region]||[]).push(c.dataset.area); });
  const btn=document.getElementById('saveCaller'); btn.disabled=true;
  try{
    let added=0;
    for(const region of Object.keys(byRegion)){
      const r=await fetch('/api/roleadmin',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({op:'add',entry:{email,role:'caller',region,areas:byRegion[region]}})});
      const d=await r.json(); if(!r.ok && r.status!==409) throw new Error(d.error||("HTTP "+r.status));
      added+=(d.added||0);
    }
    banner(`Added <b>${email}</b> as a caller${added?` for ${added} area(s)`:''}.`, false);
    document.getElementById('callerEmail').value='';
    document.querySelectorAll('.acscope').forEach(c=>c.checked=false);
    document.getElementById('addCaller').hidden=true;
    await load();
  }catch(e){ banner('Could not add caller: '+e.message, true); }
  finally{ btn.disabled=false; }
}

boot();
