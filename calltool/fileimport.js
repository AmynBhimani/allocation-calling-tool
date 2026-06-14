// Maps the Better Impact ProfileExport (.xlsx) into the normalized records the allocation engine expects.

const WESTERN_JKS = new Set([
  "BC - Burnaby Lake","BC - Chilliwack/Abbotsford","BC - Darkhana","BC - Downtown",
  "BC - Fraser Valley","BC - Headquarters","BC - Kelowna","BC - Nanaimo","BC - Richmond",
  "BC - Tri-City","BC - UNBC Campus JK","BC - Victoria",
  "Edmonton - Fort McMurray","Edmonton - North","Edmonton - Red Deer","Edmonton - South","Edmonton - West",
  "Prairies - Franklin","Prairies - Generations Calgary","Prairies - Headquarters","Prairies - Lethbridge",
  "Prairies - Northwest","Prairies - Regina","Prairies - Saskatoon","Prairies - South",
  "Prairies - Westwinds","Prairies - Winnipeg"
]);
// canonical area  ->  keyword found in that GI column header
const AREA_KEYWORDS = {
  "Food Services":"food service","Layout & Logistics":"layout","Medical Services":"medical services",
  "Parking & Transportation":"parking","Reception & Hospitality":"reception","Registration & Access":"registration",
  "Safety & Flow Management":"safety","Seniors & Mobility":"seniors"
};

let RECORDS = null;  // normalized Western records ready to send

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }

async function boot(){
  try{ const me=await (await fetch('/.auth/me')).json(); const cp=me&&me.clientPrincipal; if(cp) document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`; }catch(e){}
  document.getElementById('file').addEventListener('change', onFile);
  document.getElementById('dryBtn').addEventListener('click', ()=>run('dry'));
  document.getElementById('commitBtn').addEventListener('click', ()=>run('commit'));
}

const yes = v => String(v==null?"":v).trim().toLowerCase()==="yes";
const cert = v => { const s=String(v==null?"":v).trim().toLowerCase(); return s!=="" && s!=="no"; };

function colIndex(headers, predicate){ return headers.findIndex(h=>predicate(String(h||"").toLowerCase())); }

function onFile(e){
  const f=e.target.files[0]; if(!f) return;
  document.getElementById('fileName').textContent=f.name;
  banner('Reading file…', false);
  const reader=new FileReader();
  reader.onload=ev=>{
    try{
      const wb=XLSX.read(new Uint8Array(ev.target.result),{type:'array'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:null});
      if(!rows.length) throw new Error("empty sheet");
      const headers=rows[0];
      // resolve columns by header text (robust to the long bilingual names)
      const ix = {
        first: colIndex(headers,h=>h==="firstname"),
        last: colIndex(headers,h=>h==="lastname"),
        id: colIndex(headers,h=>h.includes("databaseuserid")),
        email: colIndex(headers,h=>h.includes("emailaddress")),
        home: colIndex(headers,h=>h==="homephone"),
        work: colIndex(headers,h=>h==="workphone"),
        cell: colIndex(headers,h=>h==="cellphone"),
        username: colIndex(headers,h=>h==="username"),
        age: colIndex(headers,h=>h==="age"),
        interfaith: colIndex(headers,h=>h.includes("inter-faith family")),
        jk: colIndex(headers,h=>h.includes("ceremony jamatkhana")),
        healthcare: colIndex(headers,h=>h.includes("healthcare professional")),
        medical: colIndex(headers,h=>h.includes("physical/ medical")||h.includes("medical conditions that affect")),
        firstaid: colIndex(headers,h=>h.includes("first aid certification")&&!h.includes("expires")),
        foodsafety: colIndex(headers,h=>h.includes("food safety")&&!h.includes("expires")),
        acls: colIndex(headers,h=>(h.includes("advanced cardiovascular")||h.includes("acls"))&&!h.includes("expires")),
        mhfa: colIndex(headers,h=>h.includes("mental health first aid")&&!h.includes("expires")),
        happy: colIndex(headers,h=>h.includes("happy to volunteer in any area")),
      };
      // GI area columns
      const areaCols={};
      for(const [canon,kw] of Object.entries(AREA_KEYWORDS)){
        areaCols[canon]=colIndex(headers,h=>h.startsWith("gi -")&&h.includes(kw));
      }
      if(ix.id<0||ix.jk<0) throw new Error("couldn't find DatabaseUserId or Ceremony Jamatkhana columns — is this the ProfileExport?");

      const all=[]; let western=0;
      for(let i=1;i<rows.length;i++){
        const r=rows[i]; if(!r||r[ix.id]==null) continue;
        const jk = ix.jk>=0 ? String(r[ix.jk]==null?"":r[ix.jk]).trim() : "";
        const areas={};
        for(const [canon,c] of Object.entries(areaCols)) areas[canon] = c>=0 ? yes(r[c]) : false;
        const rec={
          user_id: r[ix.id],
          first: ix.first>=0?(r[ix.first]||""):"", last: ix.last>=0?(r[ix.last]||""):"",
          email: ix.email>=0?(r[ix.email]||""):"", username: ix.username>=0?(r[ix.username]||""):"",
          cell_phone: ix.cell>=0?(r[ix.cell]||""):"", home_phone: ix.home>=0?(r[ix.home]||""):"", work_phone: ix.work>=0?(r[ix.work]||""):"",
          jk,
          age: ix.age>=0 && r[ix.age]!=null && r[ix.age]!=="" ? Number(r[ix.age]) : null,
          interfaith: ix.interfaith>=0?yes(r[ix.interfaith]):false,
          healthcare: ix.healthcare>=0?yes(r[ix.healthcare]):false,
          medical_conditions: ix.medical>=0?yes(r[ix.medical]):false,
          cert_firstaid: ix.firstaid>=0?cert(r[ix.firstaid]):false,
          cert_foodsafety: ix.foodsafety>=0?cert(r[ix.foodsafety]):false,
          cert_acls: ix.acls>=0?cert(r[ix.acls]):false,
          cert_mhfa: ix.mhfa>=0?cert(r[ix.mhfa]):false,
          happy_anywhere: ix.happy>=0?yes(r[ix.happy]):false,
          areas
        };
        if(WESTERN_JKS.has(jk)){ all.push(rec); western++; }
      }
      RECORDS=all;
      showParse(rows.length-1, western, all);
      clearBanner();
    }catch(err){ banner('Could not read that file: '+err.message, true); RECORDS=null; document.getElementById('runCard').hidden=true; }
  };
  reader.readAsArrayBuffer(f);
}

function showParse(totalRows, western, recs){
  // per-region tally for a quick sanity check
  const byRegion={};
  for(const r of recs){ const reg=r.jk.split(" - ")[0]; byRegion[reg]=(byRegion[reg]||0)+1; }
  document.getElementById('parsePreview').innerHTML=`
    <div style="display:flex;gap:40px;flex-wrap:wrap;margin-top:6px">
      <div><div class="bignum">${totalRows.toLocaleString()}</div><div class="sub">rows in file</div></div>
      <div><div class="bignum">${western.toLocaleString()}</div><div class="sub">Western volunteers (27 JKs)</div></div>
    </div>
    <div class="pillrow">${Object.entries(byRegion).sort().map(([r,n])=>`<span class="pill2">${r}: ${n.toLocaleString()}</span>`).join('')}</div>`;
  document.getElementById('runCard').hidden = western===0;
  document.getElementById('dryBtn').disabled = western===0;
}

async function run(mode){
  if(!RECORDS||!RECORDS.length) return;
  if(mode==='commit' && !confirm(`Commit ${RECORDS.length} Western volunteers to LIVE data? Existing reconciliation, assignments, and calls are preserved.`)) return;
  const dry=document.getElementById('dryBtn'), commit=document.getElementById('commitBtn');
  dry.disabled=true; commit.disabled=true;
  banner(mode==='commit'?'Committing…':'Running dry run…', false);
  try{
    const r=await fetch('/api/fileimport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,records:RECORDS})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    showResult(d);
    clearBanner();
    if(mode==='dry'){ document.getElementById('commitBtn').disabled=false; document.getElementById('commitWarn').hidden=false; }
  }catch(e){ banner((mode==='commit'?'Commit':'Dry run')+' failed: '+e.message, true); }
  finally{ dry.disabled=false; }
}

function showResult(d){
  const areas=Object.entries(d.byArea||{}).sort((a,b)=>b[1]-a[1]);
  const status=Object.entries(d.byStatus||{}).sort();
  document.getElementById('result').innerHTML=`
    <div class="${d.mode==='commit'?'':'warn'}" style="margin-top:14px">${d.note||''}</div>
    <div style="display:flex;gap:34px;flex-wrap:wrap;margin-top:12px">
      <div><div class="bignum">${(d.western||0).toLocaleString()}</div><div class="sub">Western processed</div></div>
      <div><div class="bignum">${(d.added||0).toLocaleString()}</div><div class="sub">added</div></div>
      <div><div class="bignum">${(d.refreshed||0).toLocaleString()}</div><div class="sub">refreshed</div></div>
      <div><div class="bignum">${(d.preserved||0).toLocaleString()}</div><div class="sub">preserved (had work)</div></div>
    </div>
    <table><thead><tr><th>Area</th><th>Count</th></tr></thead><tbody>
      ${areas.map(([a,n])=>`<tr><td>${a}</td><td>${n.toLocaleString()}</td></tr>`).join('')}
    </tbody></table>
    <div class="pillrow">${status.map(([s,n])=>`<span class="pill2">${s}: ${n.toLocaleString()}</span>`).join('')}</div>`;
}

boot();
