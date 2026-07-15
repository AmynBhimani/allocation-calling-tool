let DATA = { rows:[], totals:null, region:"All" };

function banner(msg, isErr){ const b=document.getElementById('banner'); b.hidden=false; b.className="banner"+(isErr?" err":""); b.innerHTML=msg; }
function clearBanner(){ document.getElementById('banner').hidden=true; }

async function boot(){
  try{ const me=await (await fetch('/.auth/me')).json(); const cp=me&&me.clientPrincipal; if(cp) document.getElementById('whoami').innerHTML=`<b>${cp.userDetails}</b>`; }catch(e){}
  ["BC","Prairies","Edmonton"].forEach(r=>{const o=document.createElement('option');o.value=r;o.textContent=r;document.getElementById('regionSel').appendChild(o);});
  document.getElementById('regionSel').addEventListener('change',e=>load(e.target.value));
  document.getElementById('exportBtn').addEventListener('click',exportCsv);
  var jkb=document.getElementById('exportJkBtn'); if(jkb) jkb.addEventListener('click',exportJkCsv);
  var sb=document.getElementById('exportSessBtn'); if(sb) sb.addEventListener('click',exportSessCsv);
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
  const t=DATA.totals||{assignedDuty:0,accepted:0,callPending:0,declined:0};
  document.getElementById('kpis').innerHTML=[
    ['',t.assignedDuty,'Assigned a duty','var(--ink)'],
    ['callable',t.accepted,'Accepted duty','var(--stable)'],
    ['recon',t.callPending,'Call pending','var(--recon)'],
    ['un',t.declined,'Declined duty','var(--un)'],
  ].map(([cls,n,l,col])=>`<div class="kpi ${cls}"><div class="n">${(n||0).toLocaleString()}</div>
    <div class="l">${l}</div></div>`).join('');

  const rows=document.getElementById('rows');
  if(!DATA.rows.length){
    rows.innerHTML=`<tr><td colspan="5"><div class="empty">No volunteers in the callable pipeline yet for ${DATA.region}.</div></td></tr>`;
    document.getElementById('foot').innerHTML=''; document.getElementById('count').textContent=''; return;
  }
  rows.innerHTML=DATA.rows.map(r=>`<tr>
    <td><div class="name">${r.area}</div></td>
    <td class="num">${r.assignedDuty.toLocaleString()}</td>
    <td class="num">${r.accepted.toLocaleString()}</td>
    <td class="num">${r.callPending.toLocaleString()}</td>
    <td class="num">${r.declined.toLocaleString()}</td>
  </tr>`).join('');
  document.getElementById('foot').innerHTML=`<tr class="totalrow">
    <td><b>All areas</b></td>
    <td class="num"><b>${t.assignedDuty.toLocaleString()}</b></td>
    <td class="num"><b>${t.accepted.toLocaleString()}</b></td>
    <td class="num"><b>${t.callPending.toLocaleString()}</b></td>
    <td class="num"><b>${t.declined.toLocaleString()}</b></td>
  </tr>`;
  document.getElementById('count').textContent=`${DATA.rows.length} area(s) · region: ${DATA.region}`;
  renderJk();
  renderSessions();
}

// Session rosters: area rows x session columns (there are many areas but few sessions).
function renderSessions(){
  const panel=document.getElementById('sessPanel'); if(!panel) return;
  const sess=DATA.sessions||[], rows=DATA.sessionRows||[], col=DATA.sessionColTotals||{}, h=DATA.sessionHealth||{};
  if(!sess.length){ panel.hidden=true; return; }        // no sessions configured yet — hide entirely
  panel.hidden=false;
  const head=document.getElementById('sessHead'), body=document.getElementById('sessRows'), foot=document.getElementById('sessFoot');
  const alerts=[];
  if(h.notInSession) alerts.push(`<b>${(h.notInSession).toLocaleString()}</b> accepted volunteer(s) aren\u2019t in a session yet`);
  if(h.needsRerun) alerts.push(`<b>${(h.needsRerun).toLocaleString()}</b> volunteer(s) no longer match their committed session`);
  document.getElementById('sessAlert').innerHTML = alerts.length
    ? `<div style="background:#FBEFEC;border:1px solid #EAD2CE;border-radius:9px;padding:9px 12px;font-size:13px;color:#7d4a41;margin-bottom:10px">${alerts.join(' \u00b7 ')} \u2014 re-run <a href="/sessions.html">Session allocation</a>.</div>`
    : '';
  if(!rows.length){
    head.innerHTML=''; body.innerHTML=`<tr><td><div class="empty">No one has been allocated to a session yet.</div></td></tr>`;
    foot.innerHTML=''; document.getElementById('sessCount').textContent=''; return;
  }
  head.innerHTML=`<tr><th>Area</th>${sess.map(s=>`<th class="num">${s.name}</th>`).join('')}<th class="num">Total</th></tr>`;
  body.innerHTML=rows.map(r=>`<tr><td><div class="name">${r.area}</div></td>${sess.map(s=>`<td class="num">${(r.counts[s.id]||0)?(r.counts[s.id]).toLocaleString():'\u00b7'}</td>`).join('')}<td class="num"><b>${r.total.toLocaleString()}</b></td></tr>`).join('');
  foot.innerHTML=`<tr class="totalrow"><td><b>All areas</b></td>${sess.map(s=>`<td class="num"><b>${(col[s.id]||0).toLocaleString()}</b></td>`).join('')}<td class="num"><b>${(DATA.sessionGrand||0).toLocaleString()}</b></td></tr>`;
  document.getElementById('sessCount').textContent=`${sess.length} session(s) \u00b7 ${rows.length} area(s) \u00b7 region: ${DATA.region}`;
}

function renderJk(){
  const areas=DATA.jkAreas||[], rows=DATA.jkRows||[], col=DATA.jkColTotals||{};
  const head=document.getElementById('jkHead'), body=document.getElementById('jkRows'), foot=document.getElementById('jkFoot');
  if(!head||!body||!foot) return;
  if(!rows.length){
    head.innerHTML=''; body.innerHTML=`<tr><td><div class="empty">No allocations yet for ${DATA.region}.</div></td></tr>`;
    foot.innerHTML=''; document.getElementById('jkCount').textContent=''; return;
  }
  head.innerHTML=`<tr><th>Ceremony Jamatkhana</th>${areas.map(a=>`<th class="num">${a}</th>`).join('')}<th class="num">Total</th></tr>`;
  body.innerHTML=rows.map(r=>`<tr><td><div class="name">${r.jk}</div></td>${areas.map(a=>`<td class="num">${(r.counts[a]||0)?(r.counts[a]).toLocaleString():'·'}</td>`).join('')}<td class="num"><b>${r.total.toLocaleString()}</b></td></tr>`).join('');
  foot.innerHTML=`<tr class="totalrow"><td><b>All Jamatkhanas</b></td>${areas.map(a=>`<td class="num"><b>${(col[a]||0).toLocaleString()}</b></td>`).join('')}<td class="num"><b>${(DATA.jkGrand||0).toLocaleString()}</b></td></tr>`;
  document.getElementById('jkCount').textContent=`${rows.length} Jamatkhana(s) · ${areas.length} area(s) · region: ${DATA.region}`;
}

function exportSessCsv(){
  const sess=DATA.sessions||[], rows=DATA.sessionRows||[], col=DATA.sessionColTotals||{};
  const esc=v=>{const s=String(v==null?'':v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const lines=[['Area',...sess.map(s=>s.name),'Total'].map(esc).join(',')];
  rows.forEach(r=>lines.push([r.area,...sess.map(s=>r.counts[s.id]||0),r.total].map(esc).join(',')));
  lines.push(['All areas',...sess.map(s=>col[s.id]||0),(DATA.sessionGrand||0)].map(esc).join(','));
  const blob=new Blob([lines.join('\n')],{type:'text/csv'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='session-rosters.csv'; a.click(); URL.revokeObjectURL(a.href);
}

function exportJkCsv(){
  const areas=DATA.jkAreas||[], rows=DATA.jkRows||[], col=DATA.jkColTotals||{};
  const esc=s=>{ s=String(s==null?'':s); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const lines=[['Ceremony Jamatkhana',...areas,'Total'].map(esc).join(',')];
  for(const r of rows) lines.push([r.jk,...areas.map(a=>r.counts[a]||0),r.total].map(esc).join(','));
  lines.push(['All Jamatkhanas',...areas.map(a=>col[a]||0),(DATA.jkGrand||0)].map(esc).join(','));
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`allocations-by-jk-${(DATA.region||'all')}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function exportCsv(){
  const cols=['Area','Assigned a Duty','Accepted Duty','Call Pending','Declined Duty'];
  const esc=s=>{ s=String(s==null?'':s); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const lines=[cols.join(',')];
  for(const r of DATA.rows) lines.push([r.area,r.assignedDuty,r.accepted,r.callPending,r.declined].map(esc).join(','));
  const t=DATA.totals; if(t) lines.push(['All areas',t.assignedDuty,t.accepted,t.callPending,t.declined].map(esc).join(','));
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`calling-dashboard-${(DATA.region||'all')}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

boot();
