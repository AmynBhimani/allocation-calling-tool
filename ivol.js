let ROWS = [];
const selected = new Set();
let showAll = false;

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }

async function boot(){
  try{
    const me=await (await fetch('/.auth/me')).json();
    const cp=me&&me.clientPrincipal; if(cp) document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`;
  }catch(e){}
  document.getElementById('showAll').addEventListener('change',e=>{showAll=e.target.checked;selected.clear();load();});
  document.getElementById('cbAll').addEventListener('change',e=>toggleAll(e.target.checked));
  document.getElementById('markBtn').addEventListener('click',()=>mark(true));
  document.getElementById('unmarkBtn').addEventListener('click',()=>mark(false));
  document.getElementById('exportBtn').addEventListener('click',exportCsv);
  await load();
}

async function load(){
  document.getElementById('count').textContent="Loading…";
  try{
    const r=await fetch('/api/ivolreport'+(showAll?'?all=1':''));
    if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error||("HTTP "+r.status));
    const d=await r.json(); ROWS=d.rows||[]; clearBanner(); render();
  }catch(e){ banner('Could not load the report: '+e.message,true); document.getElementById('count').textContent="Load failed."; }
}

function render(){
  const total=ROWS.length, pending=ROWS.filter(r=>!r.entered).length, entered=total-pending;
  document.getElementById('kpis').innerHTML=[
    ['',pending,'Pending entry','var(--ink)'],
    ['callable',entered,'Entered in BI','var(--stable)'],
  ].map(([cls,n,l,col])=>`<div class="kpi ${cls}"><div class="n">${n.toLocaleString()}</div>
    <div class="l">${l}</div><div class="bar"><i style="width:${total?Math.round(n/total*100):0}%;background:${col}"></i></div></div>`).join('');

  const rows=document.getElementById('rows');
  if(!ROWS.length){
    rows.innerHTML=`<tr><td colspan="7"><div class="empty">No volunteers are waiting for Better Impact entry. As callers mark people Accepted, they'll appear here.</div></td></tr>`;
    document.getElementById('count').textContent=""; updateBar(); return;
  }
  rows.innerHTML=ROWS.map(v=>{
    const checked=selected.has(v.id)?'checked':'';
    const date=v.accepted_at?new Date(v.accepted_at).toLocaleDateString():'—';
    return `<tr class="${v.entered?'entered-row':''}">
      <td class="cbcol"><input type="checkbox" class="rowcb" data-id="${v.id}" data-region="${v.region}" ${checked}></td>
      <td><div class="name">${v.first} ${v.last}</div><div class="sub">#${v.id}${v.username?' · '+v.username:''} · ${v.jk}</div></td>
      <td>${v.region}</td>
      <td><span class="committee-cell">${v.committee||'—'}</span></td>
      <td>${v.outcome||'—'}</td>
      <td><span class="sub">${date}</span></td>
      <td>${v.entered?'<span class="tick">✓ entered</span>':'<span class="sub">—</span>'}</td>
    </tr>`;
  }).join('');
  rows.querySelectorAll('.rowcb').forEach(cb=>cb.addEventListener('change',()=>{
    const id=+cb.dataset.id; if(cb.checked) selected.add(id); else selected.delete(id); updateBar();
  }));
  document.getElementById('count').textContent=`${ROWS.length} shown · ${selected.size} selected`;
  updateBar();
}

function toggleAll(on){ if(on) ROWS.forEach(v=>selected.add(v.id)); else selected.clear(); render(); }
function updateBar(){
  const n=selected.size;
  document.getElementById('selcount').textContent=`${n} selected`;
  document.getElementById('markBtn').disabled=n===0;
  document.getElementById('unmarkBtn').disabled=n===0;
  document.getElementById('cbAll').checked = n>0 && ROWS.length>0 && ROWS.every(v=>selected.has(v.id));
}

async function mark(entered){
  const items=ROWS.filter(v=>selected.has(v.id)).map(v=>({user_id:v.id,region:v.region}));
  if(!items.length) return;
  document.getElementById('markBtn').disabled=true; document.getElementById('unmarkBtn').disabled=true;
  try{
    const r=await fetch('/api/ivolreport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items,entered})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    banner(`${entered?'Marked':'Un-marked'} <b>${d.updated}</b> volunteer(s) ${entered?'as entered in BI':'as not entered'}.`,false);
    selected.clear(); await load();
  }catch(e){ banner('Update failed: '+e.message,true); updateBar(); }
}

function exportCsv(){
  // Export the currently shown rows. Committee is the key field; identifying fields included.
  const cols=['First','Last','Username','Region','Jamatkhana','Committee','Outcome','Accepted','In BI'];
  const esc=s=>{ s=String(s==null?'':s); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const lines=[cols.join(',')];
  for(const v of ROWS){
    lines.push([v.first,v.last,v.username,v.region,v.jk,v.committee,v.outcome,
      v.accepted_at?new Date(v.accepted_at).toLocaleDateString():'',v.entered?'Yes':'No'].map(esc).join(','));
  }
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  const stamp=new Date().toISOString().slice(0,10);
  a.href=url; a.download=`ivol-input-${stamp}.csv`; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

boot();
