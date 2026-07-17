let ROWS = [];
let COUNTS = { pendingCount:0, enteredCount:0 };
const selected = new Set();
let showAll = false;
const filters = { q:"", region:"", committee:"", jk:"", duty:"", dutyState:"" };

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }

async function boot(){
  try{
    const me=await (await fetch('/.auth/me')).json();
    const cp=me&&me.clientPrincipal; if(cp) document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`;
    // Undoing a duty entry asserts the shift is NOT in Better Impact after all — it un-freezes a row
    // the area has been told is settled. Super Admin only, and hidden from everyone else so it never
    // reads as a routine correction.
    if(cp && (cp.userRoles||[]).includes('superadmin')) document.getElementById('dutyUndoBtn').hidden=false;
  }catch(e){}
  document.getElementById('showAll').addEventListener('change',e=>{showAll=e.target.checked;selected.clear();load();});
  document.getElementById('cbAll').addEventListener('change',e=>toggleAll(e.target.checked));
  document.getElementById('markBtn').addEventListener('click',()=>mark(true));
  document.getElementById('unmarkBtn').addEventListener('click',()=>mark(false));
  document.getElementById('exportBtn').addEventListener('click',exportCsv);
  document.getElementById('q').addEventListener('input',e=>{filters.q=e.target.value.toLowerCase();render();});
  document.getElementById('fRegion').addEventListener('change',e=>{filters.region=e.target.value;filters.jk="";buildFilterOptions();render();});
  document.getElementById('fCommittee').addEventListener('change',e=>{filters.committee=e.target.value;render();});
  document.getElementById('fJk').addEventListener('change',e=>{filters.jk=e.target.value;render();});
  document.getElementById('fDuty').addEventListener('change',e=>{filters.duty=e.target.value;render();});
  document.getElementById('fDutyState').addEventListener('change',e=>{filters.dutyState=e.target.value;render();});
  document.getElementById('dutyBtn').addEventListener('click',()=>markDuty(false));
  document.getElementById('dutyUndoBtn').addEventListener('click',()=>markDuty(true));
  await load();
}

async function load(){
  document.getElementById('count').textContent="Loading…";
  try{
    const r=await fetch('/api/ivolreport'+(showAll?'?all=1':''));
    if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error||("HTTP "+r.status));
    const d=await r.json(); ROWS=d.rows||[]; COUNTS={pendingCount:d.pendingCount||0,enteredCount:d.enteredCount||0}; clearBanner(); buildFilterOptions(); render();
  }catch(e){ banner('Could not load the report: '+e.message,true); document.getElementById('count').textContent="Load failed."; }
}

function buildFilterOptions(){
  const regions=[...new Set(ROWS.map(r=>r.region))].sort();
  const committees=[...new Set(ROWS.map(r=>r.committee).filter(Boolean))].sort();
  const jkPool=ROWS.filter(r=>!filters.region || r.region===filters.region);
  const jks=[...new Set(jkPool.map(r=>r.jk).filter(Boolean))].sort();
  const duties=[...new Set(ROWS.map(r=>r.duty).filter(Boolean))].sort();
  setOpts('fRegion','All regions',regions,filters.region);
  setOpts('fCommittee','All committees',committees,filters.committee);
  setOpts('fJk','All Jamatkhanas',jks,filters.jk);
  setOpts('fDuty','All duties',duties,filters.duty);
}
// The four states a duty can be in from this screen's point of view. "ready" is the queue: the area
// has submitted it and it is waiting to be typed into Better Impact.
function dutyBucket(v){
  if(v.dutyState==='entered') return 'entered';
  if(v.dutyState==='submitted') return 'ready';
  if(!v.duty) return 'none';
  return 'waiting';
}
function setOpts(id,allLabel,items,cur){
  const sel=document.getElementById(id);
  sel.innerHTML=`<option value="">${allLabel}</option>`+items.map(x=>`<option value="${x}" ${x===cur?'selected':''}>${x}</option>`).join('');
}
function matches(v){
  if(filters.q && !((v.first+" "+v.last).toLowerCase().includes(filters.q))) return false;
  if(filters.region && v.region!==filters.region) return false;
  if(filters.committee && v.committee!==filters.committee) return false;
  if(filters.jk && v.jk!==filters.jk) return false;
  if(filters.duty && v.duty!==filters.duty) return false;
  if(filters.dutyState && dutyBucket(v)!==filters.dutyState) return false;
  return true;
}

function render(){
  const pending=COUNTS.pendingCount, entered=COUNTS.enteredCount, total=pending+entered;
  const dq=COUNTS.dutyQueue||0, dd=COUNTS.dutyDone||0, dtot=dq+dd;
  document.getElementById('kpis').innerHTML=[
    ['',pending,'Pending entry','var(--ink)',total],
    ['callable',entered,'Entered in BI','var(--stable)',total],
    ['',dq,'Duties to enter','var(--ink)',dtot],
    ['callable',dd,'Duties entered','var(--stable)',dtot],
  ].map(([cls,n,l,col,t])=>`<div class="kpi ${cls}"><div class="n">${n.toLocaleString()}</div>
    <div class="l">${l}</div><div class="bar"><i style="width:${t?Math.round(n/t*100):0}%;background:${col}"></i></div></div>`).join('');

  const rows=document.getElementById('rows');
  if(!ROWS.length){
    rows.innerHTML=`<tr><td colspan="9"><div class="empty">No volunteers are waiting for Better Impact entry. As callers mark people Accepted, they'll appear here.</div></td></tr>`;
    document.getElementById('count').textContent=""; updateBar(); return;
  }
  const view=ROWS.filter(matches);
  if(!view.length){
    rows.innerHTML=`<tr><td colspan="9"><div class="empty">No volunteers match these filters.</div></td></tr>`;
    document.getElementById('count').textContent="No matches."; updateBar(); return;
  }
  rows.innerHTML=view.map(v=>{
    const checked=selected.has(String(v.id))?'checked':'';
    const date=v.accepted_at?new Date(v.accepted_at).toLocaleDateString():'—';
    const b=dutyBucket(v);
    const dutyChip = b==='entered' ? '<span class="tick">✓ entered</span>'
      : b==='ready' ? '<b>ready</b>'
      : b==='waiting' ? '<span class="sub">with the area</span>'
      : '<span class="sub">—</span>';
    return `<tr class="${v.entered?'entered-row':''}">
      <td class="cbcol"><input type="checkbox" class="rowcb" data-id="${v.id}" data-region="${v.region}" ${checked}></td>
      <td><div class="name">${v.first} ${v.last}</div><div class="sub">#${v.id}${v.username?' · '+v.username:''} · ${v.jk}</div></td>
      <td>${v.region}</td>
      <td><span class="committee-cell">${v.committee||'—'}</span></td>
      <td>${v.duty?v.duty:'<span class="sub">—</span>'}${v.sessionName?`<div class="sub">${v.sessionName}</div>`:''}</td>
      <td>${v.checkIn?v.checkIn:'<span class="sub">—</span>'}</td>
      <td>${dutyChip}</td>
      <td><span class="sub">${date}</span></td>
      <td>${v.entered?'<span class="tick">✓ entered</span>':'<span class="sub">—</span>'}</td>
    </tr>`;
  }).join('');
  rows.querySelectorAll('.rowcb').forEach(cb=>cb.addEventListener('change',()=>{
    const id=cb.dataset.id; if(cb.checked) selected.add(id); else selected.delete(id); updateBar();
  }));
  document.getElementById('count').textContent=`${view.length} shown · ${selected.size} selected`;
  updateBar();
}

function toggleAll(on){ const view=ROWS.filter(matches); if(on) view.forEach(v=>selected.add(String(v.id))); else view.forEach(v=>selected.delete(String(v.id))); render(); }
function updateBar(){
  const n=selected.size;
  const view=ROWS.filter(matches);
  document.getElementById('selcount').textContent=`${n} selected`;
  document.getElementById('markBtn').disabled=n===0;
  document.getElementById('unmarkBtn').disabled=n===0;
  // The duty buttons key off what is actually selected: only a SUBMITTED duty can be entered, and
  // only an ENTERED one can be undone. A button that is enabled but silently skips everything is
  // worse than one that is off.
  const sel=ROWS.filter(v=>selected.has(String(v.id)));
  document.getElementById('dutyBtn').disabled = !sel.some(v=>dutyBucket(v)==='ready');
  document.getElementById('dutyUndoBtn').disabled = !sel.some(v=>dutyBucket(v)==='entered');
  document.getElementById('cbAll').checked = view.length>0 && view.every(v=>selected.has(String(v.id)));
}

async function mark(entered){
  const items=ROWS.filter(v=>selected.has(String(v.id))).map(v=>({user_id:v.id,region:v.region}));
  if(!items.length) return;
  document.getElementById('markBtn').disabled=true; document.getElementById('unmarkBtn').disabled=true;
  try{
    const r=await fetch('/api/ivolreport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items,entered})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    banner(`${entered?'Marked':'Un-marked'} <b>${d.updated}</b> volunteer(s) ${entered?'as entered in BI':'as not entered'}.`,false);
    selected.clear(); await load();
  }catch(e){ banner('Update failed: '+e.message,true); updateBar(); }
}

// Entering a duty LOCKS it: the area can no longer move that person, because Better Impact now holds
// the shift and the two would drift apart. That is why this is a separate action from the contact
// flag, and why it asks first.
async function markDuty(undo){
  const sel=ROWS.filter(v=>selected.has(String(v.id)));
  const eligible=sel.filter(v=>dutyBucket(v)===(undo?'entered':'ready'));
  if(!eligible.length) return;
  const skipped=sel.length-eligible.length;
  let msg = undo
    ? `Undo the duty entry for ${eligible.length} volunteer(s)?\n\nThis puts them back in the queue and lets their area move them again. Only do this if the duty is NOT actually in Better Impact.`
    : `Mark ${eligible.length} dut(ies) as entered in Better Impact?\n\nThis LOCKS them — the area can no longer change these people. Back a duty out in Better Impact first if it needs to change.`;
  if(skipped) msg += `\n\n${skipped} of your selection ${undo?'were not entered':'are not ready'} and will be skipped.`;
  if(!confirm(msg)) return;
  document.getElementById('dutyBtn').disabled=true; document.getElementById('dutyUndoBtn').disabled=true;
  try{
    const items=eligible.map(v=>({user_id:v.id,region:v.region}));
    const r=await fetch('/api/ivolreport',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({op:undo?'duty_unenter':'duty_entered',items})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    banner(d.note||`${d.updated} updated.`,false);
    selected.clear(); await load();
  }catch(e){ banner('Update failed: '+e.message,true); updateBar(); }
}

function exportCsv(){
  // Export the currently shown rows. Committee is the key field; identifying fields included.
  const cols=['First','Last','Username','Region','Jamatkhana','Committee','Session','Duty','Check-in','Duty status','Accepted','In BI'];
  const esc=s=>{ s=String(s==null?'':s); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const lines=[cols.join(',')];
  for(const v of ROWS.filter(matches)){
    lines.push([v.first,v.last,v.username,v.region,v.jk,v.committee,v.sessionName||'',v.duty||'',
      v.checkIn||'',dutyBucket(v),
      v.accepted_at?new Date(v.accepted_at).toLocaleDateString():'',v.entered?'Yes':'No'].map(esc).join(','));
  }
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  const stamp=new Date().toISOString().slice(0,10);
  a.href=url; a.download=`ivol-input-${stamp}.csv`; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

boot();
