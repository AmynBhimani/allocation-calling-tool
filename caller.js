const AREAS = ["Safety & Flow Management","Parking & Transportation","Reception & Hospitality",
  "Seniors & Mobility","Food Services","Layout & Logistics","Registration & Access","Medical Services",
  "Finance & Procurement","Environmental Sustainability"];

let ACTIVE = [], COMPLETED = [], ROLES = [];
let tab = "active";
let current = null; // currently open volunteer
let selectedOutcome = null;
const OUTCOME_LABEL = { "Accepted":"Accepted","Thinking":"Thinking about it",
  "No answer":"No answer","Declined-referred":"Decline → refer","Withdrew":"Withdrew" };

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }

async function boot(){
  try{
    const me=await (await fetch('/.auth/me')).json();
    const cp=me&&me.clientPrincipal;
    if(cp){ ROLES=cp.userRoles||[]; document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`;
      if(ROLES.includes('superadmin')||ROLES.includes('quarterback')) document.getElementById('qbLink').hidden=false; }
  }catch(e){}
  document.getElementById('tabActive').addEventListener('click',()=>{tab="active";current=null;renderAll();});
  document.getElementById('tabDone').addEventListener('click',()=>{tab="done";current=null;renderAll();});
  await load();
}

async function load(){
  document.getElementById('qcount').textContent="Loading…";
  try{
    const r=await fetch('/api/calls');
    if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error||("HTTP "+r.status));
    const d=await r.json();
    ACTIVE=d.active||[]; COMPLETED=d.completed||[];
    clearBanner(); renderAll();
  }catch(e){ banner('Could not load your calls: '+e.message,true); document.getElementById('qcount').textContent="Load failed."; }
}

function renderAll(){
  document.getElementById('tabActive').setAttribute('aria-pressed', tab==="active");
  document.getElementById('tabDone').setAttribute('aria-pressed', tab==="done");
  document.getElementById('nActive').textContent=`(${ACTIVE.length})`;
  document.getElementById('nDone').textContent=`(${COMPLETED.length})`;
  const list = tab==="active"?ACTIVE:COMPLETED;
  const ql=document.getElementById('qlist');
  if(!list.length){
    ql.innerHTML=`<div class="empty2">${tab==="active"?"No one to call right now. New assignments from your quarterback will appear here.":"No completed calls yet."}</div>`;
    document.getElementById('qcount').textContent="";
    if(tab==="active") renderPanel(null);
    return;
  }
  ql.innerHTML=list.map(v=>{
    const tag = tab==="done" ? `<span class="meta">${v.outcome||'done'}</span>`
      : (v.outcome ? `<span class="meta">last: ${v.outcome}</span>` : '<span class="unassigned-tag">not yet called</span>');
    const nobi = v.no_bi_account ? ' <span class="badge b-nobi">No BI acct</span>' : '';
    return `<div class="qitem ${current&&current.id===v.id?'active':''}" data-id="${v.id}">
      <div><div class="nm">${v.first} ${v.last}${nobi}</div><div class="meta">${v.area||'—'} · ${v.jk}</div></div>
      <div class="right">${tag}</div></div>`;
  }).join('');
  ql.querySelectorAll('.qitem').forEach(el=>el.addEventListener('click',()=>{
    const v=list.find(x=>x.id===+el.dataset.id); openCall(v);
  }));
  document.getElementById('qcount').textContent=`${list.length} ${tab==="active"?"to call":"completed"}`;
}

function openCall(v){ current=v; selectedOutcome=null; renderAll(); renderPanel(v); }

function renderPanel(v){
  const p=document.getElementById('callPanel');
  if(!v){ p.className="callcard empty-state"; p.textContent="Select someone from your list to start a call."; return; }
  p.className="callcard";
  const readonly = tab==="done";
  const badges=[];
  if(v.leader) badges.push('<span class="badge b-lead">Team Lead</span>');
  if(v.affinity) badges.push('<span class="badge b-aff">Affinity</span>');
  if(v.referred_from) badges.push(`<span class="badge b-aff">Referred from ${v.referred_from}</span>`);

  const nobiAlert = v.no_bi_account
    ? `<div class="nobi-alert">⚑ <b>No Better Impact account.</b> As part of this call, walk them through setting up an iVolunteer account before marking Accepted.</div>` : '';

  const contact = readonly
    ? `<div class="contact"><label>Cell</label><div class="phone">${v.cell||'—'}</div><label>Email</label><div>${v.email||'—'}</div></div>`
    : `<div class="contact">
         <label>First</label><input id="cFirst" value="${escapeAttr(v.first||'')}">
         <label>Last</label><input id="cLast" value="${escapeAttr(v.last||'')}">
         <label>Cell</label><input id="cCell" value="${escapeAttr(v.cell||'')}">
         <label>Email</label><input id="cEmail" value="${escapeAttr(v.email||'')}">
       </div>
       <div class="contact-note">Edits here are saved with the call and flagged for iVol to update in Better Impact (the source of truth).</div>`;

  const logHtml = (v.log&&v.log.length)
    ? `<div class="log"><h4>Call history</h4>${v.log.map(e=>`<div class="e"><span class="t">${new Date(e.ts).toLocaleString()}</span> — ${e.outcome}${e.note?': '+escapeHtml(e.note):''}</div>`).join('')}</div>`
    : '';

  if(readonly){
    const canReopen = (v.outcome==="Accepted" || v.outcome==="Withdrew");
    const reopenHtml = canReopen
      ? `<div class="saverow"><button class="btn ghost2" id="reopenBtn">Reopen — they've changed their mind</button></div>
         <div class="contact-note">Reopening returns them to your active call list. If they were already entered in Better Impact, they'll appear on the BI Updates list so iVol can correct it.</div>`
      : '';
    p.innerHTML=`<h2>${v.first} ${v.last}</h2><div class="sub2">${v.area||'—'} · ${v.jk} · #${v.id}</div>
      <div class="badge-row">${badges.join('')}</div>${contact}${logHtml}${reopenHtml}`;
    const rb=document.getElementById('reopenBtn'); if(rb) rb.addEventListener('click',()=>reopen(v));
    return;
  }

  p.innerHTML=`<h2>${v.first} ${v.last}</h2><div class="sub2">${v.area||'—'} · ${v.jk} · #${v.id}</div>
    <div class="badge-row">${badges.join('')}</div>
    ${nobiAlert}
    ${contact}
    <textarea class="note-area" id="note" placeholder="Notes from the call…"></textarea>
    <div class="outcomes">
      <button class="obtn accept" data-o="Accepted">Accepted<small>Confirmed for ${v.area||'their area'}</small></button>
      <button class="obtn" data-o="Thinking">Thinking about it<small>Will follow up</small></button>
      <button class="obtn" data-o="No answer">No answer<small>Logs an attempt</small></button>
      <button class="obtn decline" data-o="Declined-referred">Decline → refer<small>Send to another area</small></button>
      <button class="obtn withdraw" data-o="Withdrew">Withdrew<small>Out entirely</small></button>
    </div>
    <div id="extra"></div>`;
  p.querySelectorAll('.obtn').forEach(b=>b.addEventListener('click',()=>chooseOutcome(b.dataset.o)));
  current=v;
}

function chooseOutcome(o){
  selectedOutcome = o;
  // highlight the chosen outcome
  document.querySelectorAll('.obtn').forEach(b=>b.classList.toggle('chosen', b.dataset.o===o));
  const extra=document.getElementById('extra');
  let inner = '';
  if(o==="Declined-referred"){
    inner=`<div class="refbox"><label>Refer to which area?</label>
      <select id="refArea"><option value="">Choose an area…</option>${AREAS.filter(a=>a!==current.area).map(a=>`<option>${a}</option>`).join('')}</select></div>`;
  }
  extra.innerHTML = inner +
    `<div class="saverow"><button class="btn" id="saveBtn">Save “${OUTCOME_LABEL[o]||o}”</button>
       <button class="btn ghost2" id="cancelBtn">Cancel</button></div>`;
  document.getElementById('saveBtn').addEventListener('click',commit);
  document.getElementById('cancelBtn').addEventListener('click',()=>{ selectedOutcome=null; document.querySelectorAll('.obtn').forEach(b=>b.classList.remove('chosen')); extra.innerHTML=''; });
}

async function commit(){
  const o = selectedOutcome;
  if(!o) return;
  const extra = {};
  if(o==="Declined-referred"){
    const ra=(document.getElementById('refArea')||{}).value||"";
    if(!ra){ banner('Pick an area to refer to.',true); return; }
    extra.referral_area = ra;
  }
  document.getElementById('saveBtn').disabled = true;
  await save(o, extra);
}

async function save(outcome, extra){
  const note=(document.getElementById('note')||{}).value||"";
  const contact={};
  const f=document.getElementById('cFirst'), l=document.getElementById('cLast');
  const cell=document.getElementById('cCell'), email=document.getElementById('cEmail');
  if(f) contact.first=f.value; if(l) contact.last=l.value;
  if(cell) contact.cell=cell.value; if(email) contact.email=email.value;
  const body={ user_id:current.id, region:current.region, outcome, note, contact, ...extra };
  try{
    const r=await fetch('/api/calls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    banner(`Logged <b>${outcome}</b> for ${current.first} ${current.last}.`, false);
    current=null; selectedOutcome=null;
    await load();
    renderPanel(null);   // clear the right panel, ready for the next person
  }catch(e){ banner('Could not save: '+e.message,true); }
}

async function reopen(v){
  if(!confirm(`Reopen ${v.first} ${v.last} and return them to your active call list?`)) return;
  try{
    const r=await fetch('/api/calls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'reopen',user_id:v.id,region:v.region})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    banner(`Reopened ${v.first} ${v.last} — back in your active list.`, false);
    current=null; tab="active"; await load();
  }catch(e){ banner('Could not reopen: '+e.message,true); }
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

boot();
