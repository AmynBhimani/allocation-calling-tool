// Shared top navigation — renders the same role-appropriate links on every page,
// so the menu is identical wherever you are. Gates match the route permissions.
(function(){
  var NAV=[
    {href:'/index.html',       label:'Reconcile',       roles:['superadmin','admin','dutyteam']},
    {href:'/all-volunteers.html',label:'All Volunteers',    roles:['superadmin','admin','leadership']},
    {href:'/accepted.html',     label:'Accepted',         roles:['superadmin','admin','dutyteam','quarterback','leadership']},
    {href:'/caller-activity.html',label:'Caller Activity',   roles:['superadmin','admin','dutyteam','quarterback','leadership']},
    {href:'/quarterback.html', label:'Assign Callers',   roles:['superadmin','admin','quarterback']},
    {href:'/caller.html',      label:'My Calls',         roles:['superadmin','admin','caller']},
    {href:'/ivol.html',        label:'iVol report',      roles:['superadmin','admin','ivoladmin']},
    {href:'/biupdates.html',   label:'BI updates',       roles:['superadmin','admin','ivoladmin']},
    {href:'/bi-resolutions.html', label:'BI resolutions', roles:['superadmin','admin','ivoladmin']},
    {href:'/reports.html',     label:'Dashboard',        roles:['superadmin','admin','leadership']},
    {href:'/duties.html',      label:'Duties',           roles:['superadmin','admin','quarterback']},
    {href:'/duplicates.html',  label:'Duplicates',       roles:['superadmin','admin']},
    {href:'/events.html',      label:'Events',           roles:['superadmin','admin']},
    {href:'/admin.html',       label:'Team & Roles',     roles:['superadmin','admin']},
    {href:'/fileimport.html',  label:'BI import',        roles:['superadmin']},
    {href:'/migration.html',   label:'Migration',        roles:['superadmin']},
    {href:'/allocate.html',    label:'Allocation',       roles:['superadmin']},
    {href:'/sessions.html',    label:'Sessions',         roles:['superadmin']},
    {href:'/duty-rosters.html',label:'Duty rosters',     roles:['superadmin','admin']},
    {href:'/api/backup',       label:'Download backup',  roles:['superadmin']}
  ];
  function curPath(){ var p=location.pathname; if(!p||p==='/') p='/index.html'; return p; }
  function render(roles){
    var box=document.getElementById('navlinks'); if(!box) return;
    var path=curPath(), html='';
    for(var i=0;i<NAV.length;i++){
      var n=NAV[i], ok=false;
      for(var j=0;j<n.roles.length;j++){ if(roles.indexOf(n.roles[j])>=0){ ok=true; break; } }
      if(!ok) continue;
      var active=(n.href===path);
      html+='<a class="ghost'+(active?' active':'')+'" href="'+n.href+'"'+(active?' aria-current="page"':'')+'>'+n.label+'</a>';
    }
    box.innerHTML=html;
  }
  fetch('/.auth/me').then(function(r){return r.json();}).then(function(me){
    var cp=me&&me.clientPrincipal; render((cp&&cp.userRoles)||[]);
  }).catch(function(){ render([]); });
})();
