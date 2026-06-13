let DATA = { rows:[], totals:null, region:"All" };

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }

async function boot(){
  try{ const me=await (await fetch('/.auth/me')).json(); const cp=me&&me.clientPrincipal; if(cp) document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`; }catch(e){}
  ["BC","Prairies","Edmonton"].forEach(r=>{const o=document.createElement('option');o.value=r;o.textContent=r;document.getElementById('regionSel').appendChild(o);});
  document.getElementById('regionSel').addEventListener('change',e=>load(e.target.value));
  document.getElementById('exportBtn').addEventListener('click',exportCsv);
  await load("");
}

async function load(region){
  document.getElementById('count').textContent="Loading…";
  try{
    const r=await fetch('/api/reports'+(region?('?region='+encodeURIComponent(region)):''));
    if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error||("HTTP "+r.status));
    DATA=await r.json(); clearBanner(); render();
  }catch(e){ banner('Could not load the dashboard: '+e.message,true); document.getElementById('count').textContent="Load failed."; }
}

function render(){
  const t=DATA.totals||{assigned:0,called:0,accepted:0,declined:0,pending:0};
  document.getElementById('kpis').innerHTML=[
    ['',t.assigned,'Assigned','var(--ink)'],
    ['callable',t.accepted,'Accepted','var(--stable)'],
    ['recon',t.pending,'Pending calls','var(--recon)'],
    ['un',t.declined,'Declined','var(--un)'],
  ].map(([cls,n,l,col])=>`<div class="kpi ${cls}"><div class="n">${(n||0).toLocaleString()}</div>
    <div class="l">${l}</div></div>`).join('');

  const rows=document.getElementById('rows');
  if(!DATA.rows.length){
    rows.innerHTML=`<tr><td colspan="6"><div class="empty">No volunteers in the callable pipeline yet for ${DATA.region}.</div></td></tr>`;
    document.getElementById('foot').innerHTML=''; document.getElementById('count').textContent=''; return;
  }
  rows.innerHTML=DATA.rows.map(r=>`<tr>
    <td><div class="name">${r.area}</div></td>
    <td class="num">${r.assigned.toLocaleString()}</td>
    <td class="num">${r.called.toLocaleString()}</td>
    <td class="num">${r.accepted.toLocaleString()}</td>
    <td class="num">${r.declined.toLocaleString()}</td>
    <td class="num">${r.pending.toLocaleString()}</td>
  </tr>`).join('');
  document.getElementById('foot').innerHTML=`<tr class="totalrow">
    <td><b>All areas</b></td>
    <td class="num"><b>${t.assigned.toLocaleString()}</b></td>
    <td class="num"><b>${t.called.toLocaleString()}</b></td>
    <td class="num"><b>${t.accepted.toLocaleString()}</b></td>
    <td class="num"><b>${t.declined.toLocaleString()}</b></td>
    <td class="num"><b>${t.pending.toLocaleString()}</b></td>
  </tr>`;
  document.getElementById('count').textContent=`${DATA.rows.length} area(s) · region: ${DATA.region}`;
}

function exportCsv(){
  const cols=['Area','Assigned','Called','Accepted','Declined','Pending'];
  const esc=s=>{ s=String(s==null?'':s); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const lines=[cols.join(',')];
  for(const r of DATA.rows) lines.push([r.area,r.assigned,r.called,r.accepted,r.declined,r.pending].map(esc).join(','));
  const t=DATA.totals; if(t) lines.push(['All areas',t.assigned,t.called,t.accepted,t.declined,t.pending].map(esc).join(','));
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`calling-dashboard-${(DATA.region||'all')}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

boot();
