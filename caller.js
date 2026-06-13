const AREAS = ["Safety & Flow Management","Parking & Transportation","Reception & Hospitality",
  "Seniors & Mobility","Food Services","Layout & Logistics","Registration & Access","Medical Services"];

let ACTIVE = [], COMPLETED = [], ROLES = [];
let tab = "active";
let current = null; // currently open volunteer

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

function openCall(v){ current=v; renderAll(); renderPanel(v); }

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
         <label>Cell</label><input id="cCell" value="${v.cell||''}">
         <label>Email</label><input id="cEmail" value="${v.email||''}">
       </div>`;

  const logHtml = (v.log&&v.log.length)
    ? `<div class="log"><h4>Call history</h4>${v.log.map(e=>`<div class="e"><span class="t">${new Date(e.ts).toLocaleString()}</span> — ${e.outcome}${e.note?': '+escapeHtml(e.note):''}</div>`).join('')}</div>`
    : '';

  if(readonly){
    p.innerHTML=`<h2>${v.first} ${v.last}</h2><div class="sub2">${v.area||'—'} · ${v.jk} · #${v.id}</div>
      <div class="badge-row">${badges.join('')}</div>${contact}${logHtml}`;
    return;
  }

  p.innerHTML=`<h2>${v.first} ${v.last}</h2><div class="sub2">${v.area||'—'} · ${v.jk} · #${v.id}</div>
    <div class="badge-row">${badges.join('')}</div>
    ${nobiAlert}
    ${contact}
    <textarea class="note-area" id="note" placeholder="Notes from the call…"></textarea>
    <div class="outcomes">
      <button class="obtn accept" data-o="Accepted">Accepted<small>Confirmed for ${v.area||'their area'}</small></button>
      <button class="obtn" data-o="Negotiated">Negotiated<small>Yes, with conditions (notes)</small></button>
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
  const extra=document.getElementById('extra');
  if(o==="Declined-referred"){
    extra.innerHTML=`<div class="refbox"><label>Refer to which area?</label>
      <select id="refArea"><option value="">Choose an area…</option>${AREAS.filter(a=>a!==current.area).map(a=>`<option>${a}</option>`).join('')}</select>
      <button class="btn" id="confirmRef">Confirm referral</button></div>`;
    document.getElementById('confirmRef').addEventListener('click',()=>{
      const ra=document.getElementById('refArea').value;
      if(!ra){ banner('Pick an area to refer to.',true); return; }
      save(o,{referral_area:ra});
    });
  } else if(o==="Thinking"){
    extra.innerHTML=`<div class="fubox"><label>Follow-up date (optional)</label>
      <input type="date" id="fuDate"><button class="btn" id="confirmFu">Save</button></div>`;
    document.getElementById('confirmFu').addEventListener('click',()=>save(o,{followup_date:document.getElementById('fuDate').value}));
  } else {
    save(o,{});
  }
}

async function save(outcome, extra){
  const note=(document.getElementById('note')||{}).value||"";
  const contact={};
  const cell=document.getElementById('cCell'), email=document.getElementById('cEmail');
  if(cell) contact.cell=cell.value; if(email) contact.email=email.value;
  const body={ user_id:current.id, region:current.region, outcome, note, contact, ...extra };
  try{
    const r=await fetch('/api/calls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    const stays = outcome==="No answer"||outcome==="Thinking";
    banner(`Logged <b>${outcome}</b> for ${current.first} ${current.last}.`, false);
    current=null;
    await load();
  }catch(e){ banner('Could not save: '+e.message,true); }
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

boot();
