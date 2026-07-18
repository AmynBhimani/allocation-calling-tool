let ROWS = [], COUNTS = { contactCount:0, reopenCount:0 };
const selected = new Set();

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }
const FIELD_LABEL = { first:"First name", last:"Last name", email:"Email", cell_phone:"Cell phone" };

async function boot(){
  try{ const me=await (await fetch('/.auth/me')).json(); const cp=me&&me.clientPrincipal; if(cp) document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`; }catch(e){}
  document.getElementById('cbAll').addEventListener('change',e=>toggleAll(e.target.checked));
  document.getElementById('doneBtn').addEventListener('click',markDone);
  await load();
}

async function load(){
  document.getElementById('count').textContent="Loading…";
  try{
    const r=await fetch('/api/biupdates');
    if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error||("HTTP "+r.status));
    const d=await r.json();
    ROWS=d.rows||[]; COUNTS={contactCount:d.contactCount||0,reopenCount:d.reopenCount||0};
    selected.clear(); clearBanner(); render();
  }catch(e){ banner('Could not load: '+e.message,true); document.getElementById('count').textContent="Load failed."; }
}

function render(){
  document.getElementById('kpis').innerHTML=[
    ['',COUNTS.contactCount,'Contact changes','var(--ink)'],
    ['recon',COUNTS.reopenCount,'Reopened after BI entry','var(--recon)'],
  ].map(([cls,n,l,col])=>`<div class="kpi ${cls}"><div class="n">${n.toLocaleString()}</div><div class="l">${l}</div></div>`).join('');

  const rows=document.getElementById('rows');
  if(!ROWS.length){
    rows.innerHTML=`<tr><td colspan="5"><div class="empty">Nothing waiting for Better Impact. Caller edits and reopen-after-entry will appear here.</div></td></tr>`;
    document.getElementById('count').textContent=""; updateBar(); return;
  }
  rows.innerHTML=ROWS.map(v=>{
    const checked=selected.has(String(v.id))?'checked':'';
    let what='';
    if(v.changes){
      what=Object.entries(v.changes).map(([f,c])=>`<div class="chg"><b>${FIELD_LABEL[f]||f}:</b> <span class="from">${esc(c.from||'(blank)')}</span> → <span class="to">${esc(c.to||'(blank)')}</span></div>`).join('');
    }
    if(v.reopen){
      what += v.correctionReason==='recat'
        ? `<div class="chg reopen">⚑ Area changed to <b>${esc(v.committee)}</b> — update this person's committee in BI</div>`
        : `<div class="chg reopen">⚑ Reopened after BI entry — please revert/correct in BI</div>`;
    }
    return `<tr>
      <td class="cbcol"><input type="checkbox" class="rowcb" data-id="${v.id}" data-region="${v.region}" ${checked}></td>
      <td><div class="name">${v.first} ${v.last}</div><div class="sub">#${v.id}${v.username?' · '+v.username:''} · ${v.jk}</div></td>
      <td><span class="area-cell">${v.committee}</span></td>
      <td>${v.region}</td>
      <td>${what}</td>
    </tr>`;
  }).join('');
  rows.querySelectorAll('.rowcb').forEach(cb=>cb.addEventListener('change',()=>{
    const id=cb.dataset.id; if(cb.checked) selected.add(id); else selected.delete(id); updateBar();
  }));
  document.getElementById('count').textContent=`${ROWS.length} needing updates · ${selected.size} selected`;
  updateBar();
}

function toggleAll(on){ if(on) ROWS.forEach(v=>selected.add(String(v.id))); else selected.clear(); render(); }
function updateBar(){
  const n=selected.size;
  document.getElementById('selcount').textContent=`${n} selected`;
  document.getElementById('actionbar').classList.toggle('idle', n===0);
  document.getElementById('doneBtn').disabled=n===0;
  document.getElementById('cbAll').checked = ROWS.length>0 && ROWS.every(v=>selected.has(String(v.id)));
}

async function markDone(){
  const items=ROWS.filter(v=>selected.has(String(v.id))).map(v=>({user_id:v.id,region:v.region}));
  if(!items.length) return;
  document.getElementById('doneBtn').disabled=true;
  try{
    const r=await fetch('/api/biupdates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    banner(`Cleared <b>${d.updated}</b> update(s).`, false);
    await load();
  }catch(e){ banner('Update failed: '+e.message,true); updateBar(); }
}

function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
boot();
