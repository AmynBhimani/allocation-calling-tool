let DUTIES = [], MANAGEABLE = [], ALL_AREAS = [], ROLES = [];
let parsedRows = null;

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }

async function boot(){
  try{
    const me=await (await fetch('/.auth/me')).json();
    const cp=me&&me.clientPrincipal;
    if(cp){ ROLES=cp.userRoles||[]; document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`;
    }
  }catch(e){}
  document.getElementById('addBtn').addEventListener('click', addOne);
  document.getElementById('file').addEventListener('change', onFile);
  document.getElementById('uploadBtn').addEventListener('click', uploadRows);
  await load();
}

async function load(){
  try{
    const r=await fetch('/api/duties');
    if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error||("HTTP "+r.status));
    const d=await r.json();
    DUTIES=d.duties||[]; MANAGEABLE=d.manageableAreas||[]; ALL_AREAS=d.allAreas||[];
    const sel=document.getElementById('area');
    sel.innerHTML = MANAGEABLE.length
      ? MANAGEABLE.map(a=>`<option value="${a}">${a}</option>`).join('')
      : '<option value="">— no areas assigned to you —</option>';
    document.getElementById('addBtn').disabled = !MANAGEABLE.length;
    document.getElementById('scopeNote').textContent = ROLES.includes('admin')||ROLES.includes('superadmin')
      ? 'You can manage duties for all areas.'
      : `You can manage duties for: ${MANAGEABLE.join(', ')||'(none yet)'}.`;
    const af=document.getElementById('areaFilter');
    if(af){
      const cur=af.value;
      const present=ALL_AREAS.filter(a=>DUTIES.some(d=>d.area===a));
      af.innerHTML='<option value="">All areas</option>'+present.map(a=>`<option value="${a}" ${a===cur?'selected':''}>${a}</option>`).join('');
      if(!af.dataset.wired){ af.addEventListener('change', renderList); af.dataset.wired='1'; }
    }
    clearBanner(); renderList();
  }catch(e){ banner('Could not load duties: '+e.message, true); document.getElementById('list').innerHTML='<div class="empty">Load failed.</div>'; }
}

function renderList(){
  const box=document.getElementById('list');
  if(!DUTIES.length){ box.innerHTML='<div class="empty">No duties yet. Add one above or upload a file.</div>'; return; }
  const sel=document.getElementById('areaFilter'); const pick=sel?sel.value:'';
  const byArea={};
  for(const d of DUTIES){ (byArea[d.area]=byArea[d.area]||[]).push(d); }
  const order = ALL_AREAS.filter(a=>byArea[a] && (!pick || a===pick));
  if(!order.length){ box.innerHTML='<div class="empty">No duties in that area yet.</div>'; return; }
  box.innerHTML = order.map(area=>{
    const items = byArea[area].sort((a,b)=>a.name.localeCompare(b.name)).map(d=>`
      <div class="duty">
        <div><div class="dn">${esc(d.name)}</div>${d.description?`<div class="dd">${esc(d.description)}</div>`:''}</div>
      </div>`).join('');
    return `<div class="area-group"><h3>${esc(area)} <span class="sub">(${byArea[area].length})</span></h3>${items}</div>`;
  }).join('');
}

async function addOne(){
  const entry={ area:document.getElementById('area').value, name:document.getElementById('dname').value.trim(),
                description:document.getElementById('ddesc').value.trim() };
  if(!entry.name){ banner('Enter a duty name.', true); return; }
  const btn=document.getElementById('addBtn'); btn.disabled=true;
  try{
    const r=await fetch('/api/duties',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'add',entry})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    if(d.added){ banner(`Added "${entry.name}" to ${entry.area}.`, false); document.getElementById('dname').value=''; document.getElementById('ddesc').value=''; }
    else if(d.flagged && d.flagged.length){ banner(d.flagged[0]+'. Adjust the name or description if it\u2019s really different.', true); }
    else if(d.dupes){ banner('That duty already exists for this area.', true); }
    else if(d.rejected && d.rejected.length){ banner(d.rejected[0], true); }
    DUTIES=d.duties||DUTIES; renderList();
  }catch(e){ banner('Could not add: '+e.message, true); }
  finally{ btn.disabled=false; }
}


// ---- file upload ----
function pick(row, names){
  // case-insensitive, trimmed header match
  for(const key of Object.keys(row)){
    const k=String(key).trim().toLowerCase();
    if(names.includes(k)) return row[key];
  }
  return "";
}
function onFile(e){
  const f=e.target.files[0];
  if(!f){ return; }
  document.getElementById('fileName').textContent=f.name;
  const reader=new FileReader();
  reader.onload=ev=>{
    try{
      const data=new Uint8Array(ev.target.result);
      const wb=XLSX.read(data,{type:'array'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{defval:""});
      parsedRows=rows.map(r=>({
        area: String(pick(r,['area of interest','area'])).trim(),
        name: String(pick(r,['duty name','duty','name'])).trim(),
        description: String(pick(r,['duty description','description'])).trim()
      })).filter(r=>r.area||r.name);
      const valid=parsedRows.filter(r=>r.area&&r.name).length;
      banner(`Read <b>${parsedRows.length}</b> row(s) from ${f.name} — ${valid} with both area and name. Click "Upload duties" to add.`, false);
      document.getElementById('uploadBtn').disabled = valid===0;
    }catch(err){ banner('Could not read that file: '+err.message+'. Make sure it has the three columns.', true); document.getElementById('uploadBtn').disabled=true; }
  };
  reader.readAsArrayBuffer(f);
}
async function uploadRows(){
  if(!parsedRows||!parsedRows.length) return;
  const items=parsedRows.filter(r=>r.area&&r.name);
  const btn=document.getElementById('uploadBtn'); btn.disabled=true;
  try{
    const r=await fetch('/api/duties',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'add_many',items})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    let msg=`Added <b>${d.added}</b> duties.`;
    if(d.dupes) msg+=` ${d.dupes} flagged as possible duplicates.`;
    if(d.outOfScope) msg+=` ${d.outOfScope} outside your areas.`;
    if(d.invalid) msg+=` ${d.invalid} invalid (blank or unrecognized area).`;
    const details=[...(d.flagged||[]),...(d.rejected||[])];
    if(details.length){ msg+='<div class="cols" style="margin-top:8px"><b>Not added:</b><ul style="margin:6px 0 0 18px">'+
      details.slice(0,50).map(x=>`<li>${esc(x)}</li>`).join('')+'</ul>'+
      (details.length>50?`<div>…and ${details.length-50} more.</div>`:'')+'</div>'; }
    banner(msg, d.added?false:true);
    DUTIES=d.duties||DUTIES; renderList();
    parsedRows=null; document.getElementById('file').value=''; document.getElementById('fileName').textContent='No file chosen';
  }catch(e){ banner('Upload failed: '+e.message, true); btn.disabled=false; }
}

function esc(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

boot();
