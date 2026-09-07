/* Prescription Tracker v1.0 - static GitHub Pages client */
const cfg = window.APP_CONFIG || {};
const notConfigured = !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR_PROJECT') || !cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_PUBLISHABLE_KEY.includes('YOUR_');
const sb = notConfigured ? null : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});

const state = { session:null, profile:null, dispensaries:[], sites:[], wards:[], stages:[], suspensionReasons:[], currentRx:null, realtime:null };
const $ = (id) => document.getElementById(id);
const esc = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = (d) => d ? new Intl.DateTimeFormat('en-GB',{dateStyle:'short',timeStyle:'short'}).format(new Date(d)) : '—';
const roleIn = (...roles) => roles.includes(state.profile?.role);
function toast(msg, error=false){ const t=$('toast'); t.textContent=msg; t.className='toast'+(error?' error':''); setTimeout(()=>t.classList.add('hidden'),3500); }
function usernameEmail(username){ return `${String(username).toLowerCase().trim()}@${cfg.USERNAME_DOMAIN || 'users.local'}`; }

async function init(){
  if(notConfigured){ $('login-error').textContent='Configure frontend/config.js with your Supabase URL and publishable key.'; return; }
  const {data:{session}}=await sb.auth.getSession();
  if(session) await enterApp(session);
  sb.auth.onAuthStateChange(async (_event, session)=>{ if(!session) showLogin(); });
}

$('login-form').addEventListener('submit', async e=>{
  e.preventDefault(); $('login-error').textContent='';
  const {data,error}=await sb.auth.signInWithPassword({email:usernameEmail($('login-username').value),password:$('login-password').value});
  if(error){ $('login-error').textContent='Sign-in failed. Check your username and password.'; return; }
  await enterApp(data.session);
});
$('logout-btn').addEventListener('click',()=>sb.auth.signOut());

function showLogin(){ state.session=null; state.profile=null; $('app').classList.add('hidden'); $('login-screen').classList.remove('hidden'); }
async function enterApp(session){
  state.session=session;
  const {data:profile,error}=await sb.from('profiles').select('*').eq('id',session.user.id).single();
  if(error || !profile?.active){ await sb.auth.signOut(); $('login-error').textContent='Account is inactive or not configured.'; return; }
  state.profile=profile; $('login-screen').classList.add('hidden'); $('app').classList.remove('hidden');
  $('current-user').textContent=profile.display_name; $('current-role').textContent=profile.role;
  if(roleIn('superuser')) document.querySelectorAll('.admin-only,.admin-config,.governance-only').forEach(x=>x.classList.remove('hidden'));
  else if(roleIn('admin')) document.querySelectorAll('.admin-config').forEach(x=>x.classList.remove('hidden'));
  if(roleIn('governance')) document.querySelectorAll('.governance-only').forEach(x=>x.classList.remove('hidden'));
  await loadReference(); await loadQueue(); subscribeRealtime();
}

async function loadReference(){
  const [d,s,w,st,sr] = await Promise.all([
    sb.from('dispensaries').select('*,sites(name)').eq('active',true).order('name'),
    sb.from('sites').select('*').eq('active',true).order('name'),
    sb.from('wards').select('*').eq('active',true).order('name'),
    sb.from('workflow_stages').select('*').eq('active',true).order('sequence'),
    sb.from('suspension_reasons').select('*').eq('active',true).order('name')
  ]);
  state.dispensaries=d.data||[]; state.sites=s.data||[]; state.wards=w.data||[]; state.stages=st.data||[]; state.suspensionReasons=sr.data||[];
  fillSelects();
  if(roleIn('superuser')) await loadUsers();
}
function fillSelects(){
  const opts=state.dispensaries.map(d=>`<option value="${d.id}">${esc(d.sites?.name||'')} — ${esc(d.name)}</option>`).join('');
  $('dispensary-filter').innerHTML='<option value="">All dispensaries</option>'+opts; $('book-dispensary').innerHTML=opts;
  const siteOpts=state.sites.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join(''); $('disp-site').innerHTML=siteOpts; $('ward-site').innerHTML=siteOpts;
  $('book-ward').innerHTML='<option value="">Not specified</option>'+state.wards.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('');
  $('suspend-reason').innerHTML=state.suspensionReasons.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('');
  $('user-dispensaries').innerHTML=state.dispensaries.map(d=>`<label><input type="checkbox" value="${d.id}"> ${esc(d.name)}</label>`).join('');
}

for(const tab of document.querySelectorAll('.tab')) tab.addEventListener('click',async()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); tab.classList.add('active');
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active-view')); $(`view-${tab.dataset.view}`).classList.add('active-view');
  if(tab.dataset.view==='history') await searchHistory(); if(tab.dataset.view==='users'&&roleIn('superuser')) await loadUsers(); if(tab.dataset.view==='audit') await loadAudit();
});

async function loadQueue(){
  let q=sb.from('prescription_queue_view').select('*').in('state',['active','suspended','ready']).order('received_at',{ascending:true});
  if($('dispensary-filter').value) q=q.eq('dispensary_id',$('dispensary-filter').value);
  const {data,error}=await q; if(error){toast(error.message,true);return;} renderQueue(data||[]);
}
function renderQueue(rows){
  $('sum-active').textContent=rows.filter(r=>r.state==='active').length; $('sum-suspended').textContent=rows.filter(r=>r.state==='suspended').length; $('sum-ready').textContent=rows.filter(r=>r.state==='ready').length; $('sum-red').textContent=rows.filter(r=>r.kpi_colour==='red').length;
  $('queue-body').innerHTML=rows.length?rows.map(r=>`<tr><td>#${r.display_id}</td><td><strong>${esc(r.hospital_number)}</strong></td><td>${esc(r.ward_name||'—')}</td><td>${esc(r.prescription_type.toUpperCase())}${r.contains_cd?' · CD':''}</td><td>${r.item_count??'—'}</td><td>${esc(r.stage_name)}${r.state==='suspended'?' · Suspended':''}</td><td>${r.elapsed_minutes} min</td><td><span class="kpi"><i class="dot ${esc(r.kpi_colour)}"></i>${esc(r.kpi_colour)}</span></td><td><button class="btn ghost" data-open-rx="${r.id}">Open</button></td></tr>`).join(''):'<tr><td colspan="9" class="muted">No prescriptions in the live queue.</td></tr>';
  document.querySelectorAll('[data-open-rx]').forEach(b=>b.addEventListener('click',()=>openPrescription(b.dataset.openRx)));
}
$('refresh-btn').addEventListener('click',loadQueue); $('dispensary-filter').addEventListener('change',loadQueue);

$('book-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const args={p_dispensary_id:$('book-dispensary').value,p_hospital_number:$('book-hn').value,p_patient_initials:$('book-initials').value||null,p_ward_id:$('book-ward').value||null,p_prescription_type:$('book-type').value,p_priority:$('book-priority').value,p_item_count:$('book-items').value?Number($('book-items').value):null,p_contains_cd:$('book-cd').checked,p_notes:$('book-notes').value||null};
  const {data,error}=await sb.rpc('book_in_prescription',args); if(error){toast(error.message,true);return;} e.target.reset(); fillSelects(); toast(`Prescription #${data.display_id} booked in`); await loadQueue(); document.querySelector('[data-view="dashboard"]').click();
});

async function openPrescription(id){
  const {data:rx,error}=await sb.from('prescription_queue_view').select('*').eq('id',id).single();
  if(error){toast(error.message,true);return;} state.currentRx=rx; $('rx-title').textContent=`Prescription #${rx.display_id}`; $('rx-subtitle').textContent=`${rx.site_name} · ${rx.dispensary_name}`;
  $('rx-summary').innerHTML=[['Hospital number',rx.hospital_number],['Patient initials',rx.patient_initials||'—'],['Ward',rx.ward_name||'—'],['Type',rx.prescription_type.toUpperCase()],['Priority',rx.priority],['Items',rx.item_count??'—'],['Current stage',rx.stage_name],['State',rx.state],['Received',fmt(rx.received_at)]].map(([a,b])=>`<div class="detail"><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join('');
  await renderActions(rx); await loadTimeline(id);
  $('correction-panel').classList.toggle('hidden',!roleIn('admin','superuser'));
  $('rx-dialog').showModal();
}
async function renderActions(rx){
  const box=$('rx-actions'); box.innerHTML='';
  if(rx.state==='active'){
    const idx=state.stages.findIndex(s=>s.id===rx.current_stage_id); const next=state.stages[idx+1];
    if(next){ const b=document.createElement('button'); b.className='btn primary'; b.textContent=`Move to ${next.name}`; b.onclick=()=>advance(rx.id,next.code); box.appendChild(b); }
    if(roleIn('technician','pharmacist','admin','superuser')){ const s=document.createElement('button');s.className='btn danger';s.textContent='Suspend';s.onclick=()=>$('suspend-panel').classList.remove('hidden');box.appendChild(s); }
  } else if(rx.state==='suspended' && roleIn('technician','pharmacist','admin','superuser')){
    const b=document.createElement('button');b.className='btn primary';b.textContent='Resume';b.onclick=()=>resume(rx.id);box.appendChild(b);
  } else if(rx.state==='ready'){
    const b=document.createElement('button');b.className='btn primary';b.textContent='Mark collected / dispatched';b.onclick=()=>collect(rx.id);box.appendChild(b);
  }
}
async function advance(id,code){ const {error}=await sb.rpc('advance_prescription',{p_prescription_id:id,p_to_stage_code:code}); if(error){toast(error.message,true);return;} toast('Workflow updated'); await refreshOpen(id); }
async function resume(id){ const {error}=await sb.rpc('resume_prescription',{p_prescription_id:id}); if(error){toast(error.message,true);return;} toast('Prescription resumed'); await refreshOpen(id); }
async function collect(id){ const {error}=await sb.rpc('mark_collected',{p_prescription_id:id}); if(error){toast(error.message,true);return;} toast('Prescription completed'); $('rx-dialog').close(); await loadQueue(); }
$('suspend-btn').addEventListener('click',async()=>{ if(!state.currentRx)return; const {error}=await sb.rpc('suspend_prescription',{p_prescription_id:state.currentRx.id,p_reason_id:$('suspend-reason').value,p_free_text:$('suspend-note').value||null}); if(error){toast(error.message,true);return;} $('suspend-panel').classList.add('hidden');$('suspend-note').value='';toast('Prescription suspended');await refreshOpen(state.currentRx.id); });
$('correct-btn').addEventListener('click',async()=>{ if(!state.currentRx)return; const hn=$('correct-hn').value.trim(),reason=$('correct-reason').value.trim(); if(!hn||reason.length<3){toast('New hospital number and correction reason are required',true);return;} const {error}=await sb.rpc('correct_hospital_number',{p_prescription_id:state.currentRx.id,p_new_hospital_number:hn,p_reason:reason}); if(error){toast(error.message,true);return;} $('correct-hn').value='';$('correct-reason').value='';toast('Hospital number corrected and audited');await refreshOpen(state.currentRx.id); });
async function refreshOpen(id){ await loadQueue(); await openPrescriptionDataOnly(id); }
async function openPrescriptionDataOnly(id){ const {data}=await sb.from('prescription_queue_view').select('*').eq('id',id).single(); if(!data){$('rx-dialog').close();return;} state.currentRx=data;$('rx-title').textContent=`Prescription #${data.display_id}`;$('rx-summary').querySelector('.detail strong').textContent=data.hospital_number;await renderActions(data);await loadTimeline(id); }

async function loadTimeline(id){
  const {data,error}=await sb.from('prescription_events').select('*,from_stage:from_stage_id(name),to_stage:to_stage_id(name),profiles:performed_by(display_name)').eq('prescription_id',id).order('performed_at',{ascending:false});
  if(error){$('timeline').innerHTML=`<p class="error-text">${esc(error.message)}</p>`;return;}
  $('timeline').innerHTML=(data||[]).map(e=>`<div class="timeline-item"><strong>${esc(eventLabel(e))}</strong><small>${fmt(e.performed_at)} · ${esc(e.profiles?.display_name||'Unknown user')}</small>${e.details&&Object.keys(e.details).length?`<div class="muted tiny">${esc(JSON.stringify(e.details))}</div>`:''}</div>`).join('')||'<p class="muted">No events.</p>';
}
function eventLabel(e){ return ({BOOKED_IN:'Booked in',STAGE_ADVANCED:`Moved to ${e.to_stage?.name||'next stage'}`,SUSPENDED:'Suspended',RESUMED:'Resumed',COLLECTED:'Collected / dispatched',HOSPITAL_NUMBER_CORRECTED:'Hospital number corrected'})[e.event_type]||e.event_type.replaceAll('_',' '); }
$('rx-close').addEventListener('click',()=>$('rx-dialog').close());

$('history-btn').addEventListener('click',searchHistory); $('history-search').addEventListener('keydown',e=>{if(e.key==='Enter')searchHistory()});
async function searchHistory(){
  let q=sb.from('prescription_queue_view').select('*').order('received_at',{ascending:false}).limit(200); const term=$('history-search').value.trim(); const st=$('history-state').value;
  if(st) q=q.eq('state',st); if(term){ if(/^#?\d+$/.test(term)&&term.replace('#','').length<10) q=q.eq('display_id',Number(term.replace('#',''))); else q=q.ilike('hospital_number',`%${term.replace(/[%_,]/g,'')}%`); }
  const {data,error}=await q; if(error){toast(error.message,true);return;} $('history-body').innerHTML=(data||[]).map(r=>`<tr><td>#${r.display_id}</td><td>${esc(r.hospital_number)}</td><td>${esc(r.ward_name||'—')}</td><td><span class="state-pill">${esc(r.state)}</span></td><td>${esc(r.stage_name)}</td><td>${fmt(r.received_at)}</td><td><button class="btn ghost" data-history-rx="${r.id}">Open</button></td></tr>`).join('')||'<tr><td colspan="7" class="muted">No results.</td></tr>'; document.querySelectorAll('[data-history-rx]').forEach(b=>b.addEventListener('click',()=>openPrescription(b.dataset.historyRx)));
}

async function loadUsers(){
  const {data,error}=await sb.from('profiles').select('*').order('display_name'); if(error){toast(error.message,true);return;} $('users-body').innerHTML=(data||[]).map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td><td>${esc(u.role)}</td><td>${u.active?'Yes':'No'}</td><td>${u.id===state.profile.id?'':`<button class="btn ghost" data-manage-user="${u.id}" data-user-name="${esc(u.display_name)}" data-user-role="${u.role}" data-user-active="${u.active}">Manage</button>`}</td></tr>`).join(''); document.querySelectorAll('[data-manage-user]').forEach(b=>b.addEventListener('click',()=>manageUser(b)));
}

async function manageUser(btn){
  const id=btn.dataset.manageUser, name=btn.dataset.userName, currentRole=btn.dataset.userRole, isActive=btn.dataset.userActive==='true';
  const role=prompt(`Role for ${name} (admin, pharmacist, technician, assistant, governance):`,currentRole);
  if(role===null)return;
  const allowed=['admin','pharmacist','technician','assistant','governance']; if(!allowed.includes(role)){toast('Invalid role',true);return;}
  const activeAnswer=confirm(`${name} is currently ${isActive?'ACTIVE':'INACTIVE'}. Click OK to make/keep ACTIVE; Cancel to make INACTIVE.`);
  const reset=prompt('Optional: enter a new password (12+ characters), or leave blank to keep existing password:','');
  if(reset!==null && reset.length>0 && reset.length<12){toast('Password must be at least 12 characters',true);return;}
  const {data,error}=await sb.functions.invoke('manage-user',{body:{user_id:id,role,active:activeAnswer,password:reset||undefined}});
  if(error||data?.error){toast(data?.error||error.message,true);return;} toast('User updated'); await loadUsers();
}

$('create-user-form').addEventListener('submit',async e=>{
  e.preventDefault(); const ids=[...$('user-dispensaries').querySelectorAll('input:checked')].map(x=>x.value);
  const {data,error}=await sb.functions.invoke('create-user',{body:{username:$('user-username').value,display_name:$('user-display').value,role:$('user-role').value,password:$('user-password').value,dispensary_ids:ids}});
  if(error||data?.error){toast(data?.error||error.message,true);return;} e.target.reset();toast(`User ${data.username} created`);await loadUsers();
});

$('site-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('sites').insert({name:$('site-name').value.trim(),created_by:state.profile.id});if(error){toast(error.message,true);return;}e.target.reset();toast('Site added');await loadReference();});
$('disp-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('dispensaries').insert({site_id:$('disp-site').value,name:$('disp-name').value.trim(),created_by:state.profile.id});if(error){toast(error.message,true);return;}e.target.reset();toast('Dispensary added');await loadReference();});
$('ward-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('wards').insert({site_id:$('ward-site').value,name:$('ward-name').value.trim()});if(error){toast(error.message,true);return;}e.target.reset();toast('Ward/location added');await loadReference();});

async function loadAudit(){ const {data,error}=await sb.from('audit_log').select('*,profiles:actor_id(display_name)').order('created_at',{ascending:false}).limit(300); if(error){toast(error.message,true);return;} $('audit-body').innerHTML=(data||[]).map(a=>`<tr><td>${fmt(a.created_at)}</td><td>${esc(a.action)}</td><td>${esc(a.entity_type)} ${esc(a.entity_id||'')}</td><td>${esc(a.profiles?.display_name||'—')}</td><td><code>${esc(JSON.stringify(a.details||{}))}</code></td></tr>`).join(''); }

function subscribeRealtime(){
  if(state.realtime) sb.removeChannel(state.realtime);
  state.realtime=sb.channel('prescription-live').on('postgres_changes',{event:'*',schema:'public',table:'prescriptions'},()=>loadQueue()).subscribe();
}

init();
