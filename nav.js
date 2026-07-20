// Shared top navigation. Grew past one screen-width for admin/superadmin, so related links are now
// collapsed into a few labelled dropdowns; a lone link stays a plain pill. Every entry keeps its own
// role gate (matching the route permissions), and a GROUP only appears if the person can see at least
// one link inside it — so lighter roles still see a short, flat menu, not a wall of empty dropdowns.
(function(){
  // Groups render as dropdowns; ungrouped items render as flat pills (in NAV order relative to groups).
  // "at" fixes where a group sits in the bar; ungrouped items flow in their listed order around them.
  var GROUPS = [
    { label:'Volunteers', items:[
      {href:'/index.html',          label:'Reconcile',        roles:['superadmin','admin','dutyteam']},
      {href:'/all-volunteers.html', label:'All Volunteers',   roles:['superadmin','admin','leadership']},
      {href:'/accepted.html',       label:'Accepted',         roles:['superadmin','admin','dutyteam','quarterback','leadership']},
      {href:'/caller-activity.html',label:'Caller Activity',  roles:['superadmin','admin','dutyteam','quarterback','leadership']},
    ]},
    { label:'Calling', items:[
      {href:'/quarterback.html',    label:'Assign Callers',   roles:['superadmin','admin','quarterback']},
      {href:'/caller.html',         label:'My Calls',         roles:['superadmin','admin','caller']},
    ]},
    { label:'iVolunteer', items:[
      {href:'/ivol.html',           label:'iVol report',      roles:['superadmin','admin','ivoladmin']},
      {href:'/biupdates.html',      label:'BI updates',       roles:['superadmin','admin','ivoladmin']},
      {href:'/bi-resolutions.html', label:'BI resolutions',   roles:['superadmin','admin','ivoladmin']},
    ]},
    { label:'Duties', items:[
      {href:'/duties.html',         label:'Duties',           roles:['superadmin','admin','quarterback']},
      {href:'/duty-rosters.html',   label:'Duty rosters',     roles:['superadmin','admin']},
      {href:'/duty-alloc.html',     label:'Duty allocation',  roles:['superadmin']},
      {href:'/duty-review.html',    label:'Duty review',      roles:['superadmin','admin','dutyteam','quarterback']},
      {href:'/duty-email.html',     label:'Duty emails',      roles:['superadmin','admin']},
      {href:'/duties-migrate.html', label:'Recategorise duties', roles:['superadmin']},
    ]},
    { label:'Setup', items:[
      {href:'/fileimport.html',     label:'BI import',        roles:['superadmin']},
      {href:'/migration.html',      label:'Migration',        roles:['superadmin']},
      {href:'/allocate.html',       label:'Allocation',       roles:['superadmin']},
      {href:'/sessions.html',       label:'Sessions',         roles:['superadmin']},
      {href:'/events.html',         label:'Events',           roles:['superadmin','admin']},
      {href:'/duplicates.html',     label:'Duplicates',       roles:['superadmin','admin']},
    ]},
    { label:'Admin', items:[
      {href:'/admin.html',          label:'Team & Roles',     roles:['superadmin','admin']},
      {href:'/api/backup',          label:'Download backup',  roles:['superadmin']},
    ]},
  ];
  // Standalone links, placed before/after the groups. Dashboard is the at-a-glance landing.
  var SINGLES = [
    {href:'/reports.html',          label:'Dashboard',        roles:['superadmin','admin','leadership'], first:true},
  ];

  function curPath(){ var p=location.pathname; if(!p||p==='/') p='/index.html'; return p; }
  function can(item,roles){ for(var j=0;j<item.roles.length;j++){ if(roles.indexOf(item.roles[j])>=0) return true; } return false; }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];}); }

  function pill(n,path){
    var active=(n.href===path);
    return '<a class="ghost'+(active?' active':'')+'" href="'+esc(n.href)+'"'+(active?' aria-current="page"':'')+'>'+esc(n.label)+'</a>';
  }
  function dropdown(g,roles,path){
    var visible=g.items.filter(function(it){return can(it,roles);});
    if(!visible.length) return '';                       // nobody in this role sees anything here
    if(visible.length===1) return pill(visible[0],path); // a single visible item needs no menu
    var here=visible.some(function(it){return it.href===path;});   // highlight the group we're inside
    var menu=visible.map(function(it){
      var active=(it.href===path);
      return '<a class="navitem'+(active?' active':'')+'" href="'+esc(it.href)+'"'+(active?' aria-current="page"':'')+'>'+esc(it.label)+'</a>';
    }).join('');
    return '<div class="navgroup'+(here?' here':'')+'">'
      + '<button type="button" class="ghost navtoggle'+(here?' active':'')+'" aria-haspopup="true" aria-expanded="false">'
      + esc(g.label)+'<span class="caret">\u25be</span></button>'
      + '<div class="navmenu">'+menu+'</div></div>';
  }

  function render(roles){
    var box=document.getElementById('navlinks'); if(!box) return;
    var path=curPath(), html='';
    SINGLES.filter(function(s){return s.first && can(s,roles);}).forEach(function(s){ html+=pill(s,path); });
    for(var i=0;i<GROUPS.length;i++) html+=dropdown(GROUPS[i],roles,path);
    SINGLES.filter(function(s){return !s.first && can(s,roles);}).forEach(function(s){ html+=pill(s,path); });
    box.innerHTML=html;
    wire(box);
  }

  // Click-to-open (works on touch); closes on outside click or Escape. Hover-open is handled in CSS
  // for pointer devices, so this only has to manage the click/keyboard path.
  function wire(box){
    var toggles=box.querySelectorAll('.navtoggle');
    function closeAll(except){
      for(var i=0;i<toggles.length;i++){
        var g=toggles[i].parentNode;
        if(g!==except){ g.classList.remove('open'); toggles[i].setAttribute('aria-expanded','false'); }
      }
    }
    for(var i=0;i<toggles.length;i++){
      (function(btn){
        btn.addEventListener('click',function(e){
          e.preventDefault(); e.stopPropagation();
          var g=btn.parentNode, isOpen=g.classList.contains('open');
          closeAll(g);
          if(isOpen){ g.classList.remove('open'); btn.setAttribute('aria-expanded','false'); }
          else { g.classList.add('open'); btn.setAttribute('aria-expanded','true'); }
        });
      })(toggles[i]);
    }
    document.addEventListener('click',function(){ closeAll(null); });
    document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeAll(null); });
  }

  fetch('/.auth/me').then(function(r){return r.json();}).then(function(me){
    var cp=me&&me.clientPrincipal; render((cp&&cp.userRoles)||[]);
  }).catch(function(){ render([]); });
})();
