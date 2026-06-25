const AREAS = ["Safety & Flow Management","Parking & Transportation","Reception & Hospitality",
  "Seniors & Mobility","Food Services","Layout & Logistics","Registration & Access","Medical Services",
  "Finance & Procurement","Environmental Sustainability","Memorabilia & Design","Jamati Preparation"];

let ACTIVE = [], COMPLETED = [], ROLES = [];
let tab = "active";
let current = null; // currently open volunteer
let selectedOutcome = null;
let EVENTS = [];        // active top-level Didars, from /api/events
let DUTY_NAMES = {};    // area -> sorted [duty name], from /api/duties
const OUTCOME_LABEL = { "Accepted":"Accepted","Thinking":"Thinking about it",
  "No answer":"No answer","Declined-referred":"Decline → refer","Withdrew":"Withdrew","Emailed":"Emailed",
  "Duplicate":"Duplicate / already registered" };

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }

// Events + duty catalog — fetched once; the caller can still log outcomes if these fail.
async function loadConfig(){
  try{
    const [er,dr]=await Promise.all([fetch('/api/events'),fetch('/api/duties')]);
    if(er.ok){ const e=await er.json(); EVENTS=(e.events||[]).filter(x=>!x.parent && x.active!==false); }
    if(dr.ok){ const d=await dr.json(); DUTY_NAMES={};
      (d.duties||[]).forEach(x=>{ (DUTY_NAMES[x.area]=DUTY_NAMES[x.area]||[]).push(x.name); });
      Object.keys(DUTY_NAMES).forEach(a=>DUTY_NAMES[a].sort((p,q)=>p.localeCompare(q))); }
  }catch(e){ /* non-fatal */ }
}

// Heuristic: which Didar is this person's "home" (session) event, pre-ticked by default.
function isHomeDidar(ev, region){
  const s=((ev.id||'')+' '+(ev.name||'')).toLowerCase();
  if(region==='BC') return /\bbc\b|british columbia/.test(s);
  if(region==='Prairies'||region==='Edmonton') return /prairie|edmonton|\bpe\b/.test(s);
  return false;
}

// The per-event duty-capture block: tick the Didar(s) they'll serve and the candidate duties
// in their area. Pre-populated from any saved event_assignments; otherwise the home Didar is ticked.
function eventBlockHtml(v){
  if(!EVENTS.length) return '';
  const area=v.area||'';
  const duties=DUTY_NAMES[area]||[];
  // Only the Didar(s) whose regions include this volunteer's region — a caller can't assign into
  // the other region's event. (JK-level session eligibility is layered on later.)
  const evs=EVENTS.filter(ev=>Array.isArray(ev.regions) && ev.regions.includes(v.region));
  if(!evs.length) return '';
  const existing={}; let hasExisting=false;
  (v.event_assignments||[]).forEach(a=>{ existing[a.event]=new Set(a.candidate_duties||[]); hasExisting=true; });
  const rows=evs.map(ev=>{
    const evAsg=existing[ev.id];
    const serving = evAsg ? true : (!hasExisting && isHomeDidar(ev, v.region));
    const dutyChecks = duties.length
      ? duties.map(dn=>{
          const ck = evAsg && evAsg.has(dn) ? 'checked' : '';
          return `<label class="dutychk"><input type="checkbox" class="ev-duty" data-ev="${escapeAttr(ev.id)}" value="${escapeAttr(dn)}" ${ck}> ${escapeHtml(dn)}</label>`;
        }).join('')
      : `<div class="nodut">No duty templates yet for ${escapeHtml(area||'this area')} — you can still confirm the Didar; a specific duty is assigned later.</div>`;
    return `<div class="evrow">
        <label class="evserve"><input type="checkbox" class="ev-serve" data-ev="${escapeAttr(ev.id)}" ${serving?'checked':''}> <b>${escapeHtml(ev.name)}</b></label>
        <div class="ev-duties ${serving?'':'hidden'}" data-evbox="${escapeAttr(ev.id)}">
          <div class="ev-duties-h">Possible duties in ${escapeHtml(area||'their area')}:</div>
          ${dutyChecks}
        </div>
      </div>`;
  }).join('');
  return `<div class="eventcap">
      <div class="eventcap-h">Events &amp; possible duties</div>
      <div class="eventcap-sub">Tick the Didar(s) they'll serve and any duties they could do in <b>${escapeHtml(area||'their area')}</b>. More than one duty is fine — the single committed duty is assigned later.</div>
      ${rows}
    </div>`;
}

// Short hint about who this written-in person might already be (from the name match).
function dupCandidateText(pd){
  const c=(pd&&pd.candidates&&pd.candidates[0])||null;
  if(!c) return '';
  const who=c.name||('record #'+c.user_id);
  return ' as '+escapeHtml(who)+(c.email?` (${escapeHtml(c.email)})`:'');
}

// The quarterback's pre-assigned duty, shown read-only. The caller doesn't change it here —
// ticking one or more "possible duties" below overrides it. The email confirms the area only.
function dutyPickerHtml(v){
  const cur=v.duty||'';
  if(!cur) return '';
  return `<div class="dutypick">
    <span class="dutypick-label">Pre-assigned duty:</span>
    <span class="dutypick-val">${escapeHtml(cur)}</span>
    <span class="sub">— ticking duties below overrides this; the email confirms the area only</span>
  </div>`;
}

// Read the capture UI into event_assignments rows (deferred-session model).
function collectAssignments(){
  const out=[];
  document.querySelectorAll('.ev-serve').forEach(cb=>{
    if(!cb.checked) return;
    const ev=cb.dataset.ev;
    const duties=[...document.querySelectorAll('.ev-duty[data-ev="'+ev+'"]')].filter(x=>x.checked).map(x=>x.value);
    out.push({ event:ev, area:(current&&current.area)||'', candidate_duties:duties, duty:null, basis:'pending', state:'confirmed' });
  });
  return out;
}
function eventName(id){ const e=EVENTS.find(x=>x.id===id); return e?e.name:id; }

async function boot(){
  try{
    const me=await (await fetch('/.auth/me')).json();
    const cp=me&&me.clientPrincipal;
    if(cp){ ROLES=cp.userRoles||[]; document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`; }
  }catch(e){}
  document.getElementById('tabActive').addEventListener('click',()=>{tab="active";current=null;renderAll();});
  document.getElementById('tabDone').addEventListener('click',()=>{tab="done";current=null;renderAll();});
  await loadConfig();
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
    const tag = tab==="done"
      ? `<span class="meta">${OUTCOME_LABEL[v.outcome]||v.outcome||'done'}</span>`
      : (v.outcome
          ? (v.outcome==="Emailed"
              ? `<span class="badge b-email">✉ Emailed</span>`
              : `<span class="meta">last: ${OUTCOME_LABEL[v.outcome]||v.outcome}</span>`)
          : (v.confirm_sent && !v.confirmed
              ? `<span class="meta">✉ email prepared</span>`
              : '<span class="unassigned-tag">not yet called</span>'));
    const nobi = v.no_bi_account ? ' <span class="badge b-nobi">No BI acct</span>' : '';
    return `<div class="qitem ${current&&current.id===v.id?'active':''}" data-id="${v.id}">
      <div><div class="nm">${v.first} ${v.last}${nobi}</div><div class="meta">${v.area||'—'} · ${v.jk}${v.age!=null?' · '+v.age+'y':''}</div></div>
      <div class="right">${tag}</div></div>`;
  }).join('');
  ql.querySelectorAll('.qitem').forEach(el=>el.addEventListener('click',()=>{
    const v=list.find(x=>String(x.id)===String(el.dataset.id)); openCall(v);
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

  const referralNote = v.referral_reason
    ? `<div class="dup-alert">↺ <b>Reopened by review.</b> ${escapeHtml(v.referral_reason)} They were previously in <b>${escapeHtml(v.referred_from || "another area")}</b> and have been moved here for a fresh call.</div>` : '';
  const nobiAlert = v.no_bi_account
    ? `<div class="nobi-alert">⚑ <b>No Better Impact account.</b> As part of this call, walk them through setting up an iVolunteer account before marking Accepted.</div>` : '';
  const dupAlert = v.potential_duplicate
    ? `<div class="dup-alert">⚠ <b>Possible duplicate.</b> A reviewer wrote this person in by hand; they may already be registered${dupCandidateText(v.potential_duplicate)}. Please confirm with them on the call. If they're already registered, mark <b>Duplicate / already registered</b>; otherwise continue as a new volunteer.</div>` : '';

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
    const asgRO = (v.event_assignments&&v.event_assignments.length)
      ? `<div class="log"><h4>Events &amp; duties captured</h4>${v.event_assignments.map(a=>{
           const ds=(a.candidate_duties||[]).join(', ')||'duty to be assigned';
           return `<div class="e"><b>${escapeHtml(eventName(a.event))}</b> — ${escapeHtml(ds)}</div>`;
         }).join('')}</div>`
      : '';
    p.innerHTML=`<h2>${v.first} ${v.last}</h2><div class="sub2">${v.area||'—'} · ${v.jk}${v.age!=null?' · age '+v.age:''} · #${v.id}</div>
      <div class="badge-row">${badges.join('')}</div>${contact}${asgRO}${logHtml}${reopenHtml}`;
    const rb=document.getElementById('reopenBtn'); if(rb) rb.addEventListener('click',()=>reopen(v));
    return;
  }

  let savedName=''; try{ savedName=localStorage.getItem('vrt_caller_name')||''; }catch(e){}
  const emailRow = v.email
    ? `<div class="emailbox">
         ${(v.confirm_sent && !v.confirmed) ? `<div class="contact-note">✉ Accept-link email prepared earlier — awaiting their click.</div>` : ''}
         <div class="frow"><label>Your name</label><input id="callerName" placeholder="e.g., Amyn Bhimani" value="${escapeAttr(savedName)}"></div>
         <button class="btn ghost2" id="emailBtn">${(v.confirm_sent && !v.confirmed) ? 'Re-create accept-link email' : 'Create accept-link email'}</button>
         <div class="contact-note">Tried and couldn't reach them? Create a ready-to-send email with an accept link, then copy &amp; paste it into a new message from your iiCanada Outlook. Once they confirm, no more calls needed.</div>
         <div id="emailCompose"></div>
       </div>`
    : `<div class="contact-note">No email on file — an accept link can't be sent. Keep trying by phone.</div>`;
  p.innerHTML=`<h2>${v.first} ${v.last}</h2><div class="sub2">${v.area||'—'} · ${v.jk}${v.age!=null?' · age '+v.age:''} · #${v.id}</div>
    <div class="badge-row">${badges.join('')}</div>
    ${referralNote}
    ${nobiAlert}
    ${dupAlert}
    ${contact}
    ${dutyPickerHtml(v)}
    ${eventBlockHtml(v)}
    ${emailRow}
    <textarea class="note-area" id="note" placeholder="Notes from the call…"></textarea>
    <div class="outcomes">
      <button class="obtn accept" data-o="Accepted">Accepted<small>Confirmed for ${v.area||'their area'}</small></button>
      <button class="obtn" data-o="Thinking">Thinking about it<small>Will follow up</small></button>
      <button class="obtn" data-o="No answer">No answer<small>Logs an attempt</small></button>
      <button class="obtn email" data-o="Emailed" ${v.confirm_sent?'':'disabled'}>✉ Emailed<small>${v.confirm_sent?'Mark the accept-link email as sent':'Create the email above first'}</small></button>
      <button class="obtn decline" data-o="Declined-referred">Decline → refer<small>Send to another area</small></button>
      <button class="obtn withdraw" data-o="Withdrew">Withdrew<small>Out entirely</small></button>
      ${v.potential_duplicate?`<button class="obtn dup" data-o="Duplicate">Duplicate / already registered<small>Same person already in the system</small></button>`:''}
    </div>
    <div id="extra"></div>`;
  p.querySelectorAll('.obtn').forEach(b=>b.addEventListener('click',()=>chooseOutcome(b.dataset.o)));
  const eb=document.getElementById('emailBtn'); if(eb) eb.addEventListener('click',()=>sendConfirmEmail(v));
  const cn=document.getElementById('callerName'); if(cn) cn.addEventListener('input',()=>{ try{ localStorage.setItem('vrt_caller_name', cn.value); }catch(e){} });
  p.querySelectorAll('.ev-serve').forEach(cb=>cb.addEventListener('change',()=>{
    const box=p.querySelector('.ev-duties[data-evbox="'+cb.dataset.ev+'"]');
    if(box) box.classList.toggle('hidden', !cb.checked);
  }));
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
  const body={ user_id:current.id, region:current.region, outcome, note, contact, event_assignments:collectAssignments(), ...extra };
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

async function sendConfirmEmail(v){
  const btn=document.getElementById('emailBtn'); if(btn) btn.disabled=true;
  try{
    const r=await fetch('/api/calls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'send_confirm',user_id:v.id,region:v.region,event_assignments:collectAssignments()})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    const url=`${location.origin}/confirm.html?u=${encodeURIComponent(v.id)}&r=${encodeURIComponent(v.region)}&t=${encodeURIComponent(d.token)}`;
    const urlAttr=url.replace(/&/g,'&amp;');
    const to=d.email||v.email;
    let signName=''; try{ signName=(document.getElementById('callerName')||{}).value||localStorage.getItem('vrt_caller_name')||''; }catch(e){}
    signName=(signName||'').trim()||'[Your name]';
    const subject="Volunteer Duty Confirmation - Mawlana Hazar Imam's Visit";
    const first=escapeHtml(d.first||v.first), areaTxt=escapeHtml(d.area||v.area), sign=escapeHtml(signName);
    const intro="We are pleased to inform you that you have been assigned to a duty at the upcoming visit of our beloved Mawlana Hazar Imam to Canada. This assignment was based on the area(s) of interest you indicated during the registration process. We hope you are excited to meet your fellow volunteers and participate in delivering a truly memorable, blessed, and joyous event.";
    const closing="You will receive another email confirming the details of your seva shortly. If you have questions or would rather serve in a different role, please reach out to me at this email address.";
    // rich HTML version — the link shows as friendly text and stays clickable when pasted into Outlook
    // Role lines reflect the events + candidate duties captured during the call.
    const asg=collectAssignments();
    let roleHtml, rolePlain;
    if(asg.length){
      const items=asg.map(a=>({ nm:eventName(a.event), ds:(a.candidate_duties.length?a.candidate_duties.join(', '):'duty to be confirmed') }));
      roleHtml=`<p>Based on our conversation, here's where you'll be helping:</p><ul>`
        +items.map(i=>`<li><b>${escapeHtml(i.nm)}</b> — ${escapeHtml(i.ds)}</li>`).join('')+`</ul>`;
      rolePlain=`Based on our conversation, here's where you'll be helping:\n`
        +items.map(i=>`  - ${i.nm} - ${i.ds}`).join('\n');
    } else {
      roleHtml=`<p>Your assigned role is as follows: <b>${areaTxt}</b>.</p>`;
      rolePlain=`Your assigned role is as follows: ${d.area||v.area}.`;
    }
    const bodyHtml=`<p>Ya Ali Madad dear ${first},</p>`
      +`<p>${intro}</p>`
      +roleHtml
      +`<p>Please click the link below to accept this assignment.</p>`
      +`<p><a href="${urlAttr}">Accept this assignment</a></p>`
      +`<p>${closing}</p>`
      +`<p>Warm regards,<br>${sign}<br>Volunteer Experience Team</p>`;
    // plain-text fallback (used if pasted into a plain-text field) — keeps the full URL
    const bodyPlain=`Ya Ali Madad dear ${d.first||v.first},\n\n${intro}\n\n${rolePlain}\n\nPlease click the link below to accept this assignment:\n${url}\n\n${closing}\n\nWarm regards,\n${signName}\nVolunteer Experience Team`;
    const box=document.getElementById('emailCompose');
    box.innerHTML=`
      <div class="compose">
        <div class="frow"><label>To</label><input id="emTo" readonly value="${escapeAttr(to)}"><button class="btn ghost2 cbtn" data-c="emTo">Copy</button></div>
        <div class="frow"><label>Subject</label><input id="emSubj" readonly value="${escapeAttr(subject)}"><button class="btn ghost2 cbtn" data-c="emSubj">Copy</button></div>
        <label class="emlabel">Message preview</label>
        <div id="emPreview" class="empreview">${bodyHtml}</div>
        <div class="composeacts">
          <button class="btn" id="copyMsg">Copy email</button>
        </div>
        <div class="contact-note">Click <b>Copy email</b>, then paste into a new message in your <b>iiCanada Outlook</b> — the “Accept this assignment” link stays clickable. Paste the To and Subject into their own fields.</div>
        <details class="backuplink"><summary>Link not clickable after pasting? Use the plain link instead</summary>
          <div class="frow"><input id="emUrl" readonly value="${escapeAttr(url)}"><button class="btn ghost2 cbtn" data-c="emUrl">Copy link</button></div>
        </details>
      </div>`;
    box.querySelectorAll('.cbtn').forEach(b=>b.addEventListener('click',()=>copyText((document.getElementById(b.dataset.c)||{}).value||'',b)));
    document.getElementById('copyMsg').addEventListener('click',e=>copyRich(bodyHtml,bodyPlain,e.currentTarget));
    v.confirm_sent=true;
    // unlock the "Emailed" outcome button now that the template exists
    const eo=document.querySelector('.obtn.email');
    if(eo){ eo.disabled=false; const s=eo.querySelector('small'); if(s) s.textContent='Mark the accept-link email as sent'; }
    renderAll();   // refresh the left list so its tag updates immediately (no page refresh needed)
    banner(`Accept-link email ready for ${v.first} ${v.last}. Click “Copy email”, then paste into a new Outlook message. When sent, mark <b>✉ Emailed</b> and Save.`, false);
  }catch(e){ banner('Could not prepare the email: '+e.message,true); }
  finally{ if(btn) btn.disabled=false; }
}

function copyText(txt, btn){
  const done=()=>{ if(btn){ const o=btn.textContent; btn.textContent='Copied ✓'; setTimeout(()=>btn.textContent=o,1500);} };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done).catch(()=>fallbackCopy(txt,done));
  } else { fallbackCopy(txt,done); }
}
// Copy as rich text (HTML) with a plain-text fallback, so a pasted link keeps its friendly wording.
function copyRich(html, plain, btn){
  const done=()=>{ if(btn){ const o=btn.textContent; btn.textContent='Copied ✓'; setTimeout(()=>btn.textContent=o,1500);} };
  if(navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem!=='undefined'){
    try{
      const item=new ClipboardItem({
        'text/html': new Blob([html],{type:'text/html'}),
        'text/plain': new Blob([plain],{type:'text/plain'})
      });
      navigator.clipboard.write([item]).then(done).catch(()=>fallbackRich(html,plain,done));
      return;
    }catch(e){ /* fall through */ }
  }
  fallbackRich(html, plain, done);
}
function fallbackRich(html, plain, done){
  // select a temporary rich element and use execCommand so the HTML link is preserved
  const div=document.createElement('div');
  div.setAttribute('contenteditable','true'); div.innerHTML=html;
  div.style.position='fixed'; div.style.left='-9999px'; div.style.opacity='0';
  document.body.appendChild(div);
  const range=document.createRange(); range.selectNodeContents(div);
  const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  let ok=false; try{ ok=document.execCommand('copy'); }catch(e){}
  sel.removeAllRanges(); document.body.removeChild(div);
  if(ok){ done&&done(); } else { fallbackCopy(plain, done); }
}
function fallbackCopy(txt, done){
  const ta=document.createElement('textarea'); ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try{ document.execCommand('copy'); done&&done(); }catch(e){}
  document.body.removeChild(ta);
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

boot();
