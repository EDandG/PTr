/* Prescription Tracker v1.6 - static GitHub Pages client */
const cfg = window.APP_CONFIG || {};
const notConfigured = !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR_PROJECT') || !cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_PUBLISHABLE_KEY.includes('YOUR_');
const sb = notConfigured ? null : window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});

const ROLE_LABELS = { admin:'Admin', pharmacist:'Pharmacist', technician:'Pharmacy Technician', assistant:'Pharmacy Assistant', governance:'Governance' };

// Tickable clinical permissions - any account with can_manage_users may grant these.
// Hospital-number correction is NOT here any more: it now rides on
// perm_progress_pharmacist (whoever can mark a prescription "Checked").
const CLINICAL_PERMS = [
  {key:'perm_book_in', label:'Booking in a prescription', hint:''},
  {key:'perm_progress_standard', label:'Progress ordinary workflow stages', hint:'Awaiting Labelling and Assembly through to Awaiting Final Check'},
  {key:'perm_progress_pharmacist', label:"Change status to 'Checked'", hint:'Pharmacist sign-off — the final check stage. Also allows correcting hospital numbers.'},
  {key:'perm_suspend_resume', label:'Suspend / resume prescriptions', hint:"Includes choosing a suspension reason; 'Other' needs a note"},
  {key:'perm_view_all_dispensaries', label:'View all dispensaries', hint:'Not limited to allocated dispensaries'},
];
// Responsible Pharmacist is unique to the Pharmacist role - tickable, but only
// enabled once "Pharmacist" is selected as the role, and requires a GPhC number.
const RP_PERM = {key:'perm_responsible_pharmacist', label:'Responsible Pharmacist eligible', hint:'Pharmacist role only — requires a GPhC number'};
const TICKABLE_PERMS = CLINICAL_PERMS.concat([RP_PERM]);
// Not tickable - these are Admin's (and Governance's, for view-audit) built-in
// capabilities, derived entirely from the role. Kept here only so the Users
// list can show them as badges.
const AUTO_PERMS = [
  {key:'perm_manage_users', label:'Manage users'},
  {key:'perm_manage_config', label:'Configure sites/wards, incl. import'},
  {key:'perm_view_audit', label:'View governance audit log'},
];
const ALL_PERMS = TICKABLE_PERMS.concat(AUTO_PERMS);

const state = { session:null, profile:null, dispensaries:[], sites:[], wards:[], stages:[], suspensionReasons:[], currentRx:null, realtime:null, users:[], rpSessions:[], managingUserId:null, importRows:[], kpiRules:[] };
const $ = (id) => document.getElementById(id);
const esc = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = (d) => d ? new Intl.DateTimeFormat('en-GB',{dateStyle:'short',timeStyle:'short'}).format(new Date(d)) : '—';
const can = (permKey) => !!(state.profile?.is_superuser || state.profile?.[permKey]);
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
  $('current-user').textContent=profile.display_name;
  $('current-role').textContent=profile.is_superuser?'Superuser':(ROLE_LABELS[profile.role]||profile.role);
  if(can('perm_manage_users')) document.querySelectorAll('.perm-users').forEach(x=>x.classList.remove('hidden'));
  if(can('perm_manage_config')) document.querySelectorAll('.perm-config').forEach(x=>x.classList.remove('hidden'));
  if(can('perm_view_audit')) document.querySelectorAll('.perm-audit').forEach(x=>x.classList.remove('hidden'));
  initPermGrids();
  await loadReference(); await loadQueue(); await loadRP(); subscribeRealtime();
}

/* ---------- Tiles flyout (tap fallback for touch devices; hover handles desktop via CSS) ---------- */
$('tiles-trigger').addEventListener('click', ()=>$('tiles-flyout').classList.toggle('open'));
document.addEventListener('click', (e)=>{
  if(!$('tiles-flyout').classList.contains('open')) return;
  if($('tiles-flyout').contains(e.target) || e.target===$('tiles-trigger')) return;
  $('tiles-flyout').classList.remove('open');
});

/* ---------- Permission grids + role-driven form behaviour ---------- */
function initPermGrids(){
  const permHtml=(p,idPrefix)=>`<label class="perm-item" data-perm-key="${p.key}"><input type="checkbox" id="${idPrefix}-${p.key}"><span>${esc(p.label)}${p.hint?`<small>${esc(p.hint)}</small>`:''}</span></label>`;
  $('user-perms-clinical').innerHTML = TICKABLE_PERMS.map(p=>permHtml(p,'up')).join('');
  $('mu-perms-clinical').innerHTML = TICKABLE_PERMS.map(p=>permHtml(p,'mu')).join('');
  $('user-role').addEventListener('change', ()=>syncRoleDependentUI('up'));
  $('mu-role').addEventListener('change', ()=>syncRoleDependentUI('mu'));
  syncRoleDependentUI('up'); syncRoleDependentUI('mu');
}
function syncRoleDependentUI(prefix){
  const roleSel = prefix==='up' ? $('user-role') : $('mu-role');
  const role = roleSel.value;
  const gphcInput = prefix==='up' ? $('user-gphc') : $('mu-gphc');
  const rpBox = document.getElementById(`${prefix}-perm_responsible_pharmacist`);
  const isPharmacist = role === 'pharmacist';
  gphcInput.required = isPharmacist;
  if(rpBox){
    rpBox.disabled = !isPharmacist;
    if(!isPharmacist) rpBox.checked = false;
    rpBox.closest('.perm-item')?.classList.toggle('perm-item-disabled', !isPharmacist);
  }
  const notes=[];
  if(role==='admin') notes.push('Admin accounts automatically get Manage users, Configure sites/wards and View audit — the same access as a superuser, except they can never touch a superuser account or create another one.');
  if(role==='governance') notes.push('Governance accounts automatically get View audit and can view all dispensaries.');
  if(role==='pharmacist') notes.push('Pharmacist accounts require a GPhC number. Only Pharmacist accounts can be ticked Responsible Pharmacist eligible, and only Pharmacist-permission holders can correct a hospital number.');
  const noteEl = prefix==='up' ? $('user-role-note') : $('mu-role-note');
  noteEl.textContent = notes.join(' ');
}
function collectPerms(idPrefix){ const perms={}; TICKABLE_PERMS.forEach(p=>{ const el=document.getElementById(`${idPrefix}-${p.key}`); if(el) perms[p.key]=el.checked; }); return perms; }

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
  if(can('perm_manage_users')) await loadUsers();
  if(can('perm_manage_config')) await loadKpiRules();
}
function fillSelects(){
  const opts=state.dispensaries.map(d=>`<option value="${d.id}">${esc(d.sites?.name||'')} — ${esc(d.name)}</option>`).join('');
  $('dispensary-filter').innerHTML='<option value="">All dispensaries</option>'+opts; $('book-dispensary').innerHTML=opts;
  const siteOpts=state.sites.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('disp-site').innerHTML=siteOpts; $('ward-site').innerHTML=siteOpts;
  $('book-site').innerHTML='<option value="">All hospitals</option>'+siteOpts;
  $('book-ward').innerHTML='<option value="" disabled selected>Select a ward…</option>'+state.wards.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('');
  $('suspend-reason').innerHTML=state.suspensionReasons.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('');
  syncSuspendOtherRequirement();
  $('user-dispensaries').innerHTML=state.dispensaries.map(d=>`<label><input type="checkbox" value="${d.id}"> ${esc(d.name)}</label>`).join('');
}

for(const tab of document.querySelectorAll('.tab')) tab.addEventListener('click',async()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); tab.classList.add('active');
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active-view')); $(`view-${tab.dataset.view}`).classList.add('active-view');
  if(tab.dataset.view==='history') await searchHistory();
  if(tab.dataset.view==='users' && can('perm_manage_users')) await loadUsers();
  if(tab.dataset.view==='audit' && can('perm_view_audit')) await loadAudit();
});

/* ---------- Ward / hospital auto-allocation ---------- */
function filterBookDispensaryBySite(siteId){
  const list = state.dispensaries.filter(d=>!siteId||d.site_id===siteId);
  $('book-dispensary').innerHTML = list.map(d=>`<option value="${d.id}">${esc(d.sites?.name||'')} — ${esc(d.name)}</option>`).join('');
}
function filterBookWardBySite(siteId){
  const list = state.wards.filter(w=>!siteId||w.site_id===siteId);
  $('book-ward').innerHTML = '<option value="" disabled selected>Select a ward…</option>'+list.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('');
}
$('book-ward').addEventListener('change', ()=>{
  const wardId=$('book-ward').value; if(!wardId) return;
  const ward=state.wards.find(w=>w.id===wardId); if(!ward) return;
  $('book-site').value=ward.site_id; filterBookDispensaryBySite(ward.site_id);
});
$('book-site').addEventListener('change', ()=>{
  const siteId=$('book-site').value; filterBookDispensaryBySite(siteId); filterBookWardBySite(siteId);
});

/* ---------- Queue ---------- */
async function loadQueue(){
  let q=sb.from('prescription_queue_view').select('*').in('state',['active','suspended','ready']).order('received_at',{ascending:true});
  if($('dispensary-filter').value) q=q.eq('dispensary_id',$('dispensary-filter').value);
  const {data,error}=await q; if(error){toast(error.message,true);return;} renderQueue(data||[]);
}
// The row itself is the KPI indicator: a left-to-right fill, coloured by
// which zone (green/amber/red) the elapsed time against the target sits in.
function kpiFillStyle(r){
  if(r.state==='suspended' || r.state==='ready' || r.state==='collected' || !r.red_minutes) return '';
  const pct = Math.max(0, Math.min(100, (r.elapsed_minutes / r.red_minutes) * 100));
  const colours = {green:'rgba(76,174,49,.24)', amber:'rgba(210,147,27,.26)', red:'rgba(191,59,50,.28)'};
  const colour = colours[r.kpi_colour] || colours.green;
  return ` style="background:linear-gradient(to right, ${colour} ${pct}%, transparent ${pct}%)"`;
}
const TYPE_ORDER = ['prescreened','inpatient','tto','outpatient','other'];
const TYPE_LABELS = {prescreened:'Prescreened', inpatient:'Inpatients', tto:'TTOs', outpatient:'Outpatients', other:'Other'};
function typeLabel(type){ return TYPE_LABELS[type] || (type.charAt(0).toUpperCase()+type.slice(1)); }
function renderQueueRow(r){
  const cls=['row-clickable']; if(r.state==='suspended') cls.push('row-suspended'); if(r.state==='ready'||r.state==='collected') cls.push('row-complete');
  return `<tr class="${cls.join(' ')}"${kpiFillStyle(r)} data-open-rx="${r.id}"><td>#${r.display_id}</td><td><strong>${esc(r.hospital_number)}</strong></td><td>${esc(r.ward_name||'—')}</td><td>${esc(r.prescription_type.toUpperCase())}${r.contains_cd?' · CD':''}</td><td>${r.item_count??'—'}</td><td>${esc(r.stage_name)}${r.state==='suspended'?' · Suspended':''}${r.needed_by?`<br><small class="muted">Needed by ${fmt(r.needed_by)}</small>`:''}</td><td>${r.elapsed_minutes} min</td></tr>`;
}
function renderQueue(rows){
  $('sum-active').textContent=rows.filter(r=>r.state==='active').length; $('sum-suspended').textContent=rows.filter(r=>r.state==='suspended').length; $('sum-ready').textContent=rows.filter(r=>r.state==='ready').length; $('sum-red').textContent=rows.filter(r=>r.kpi_colour==='red').length;
  if(!rows.length){ $('queue-body').innerHTML='<tr><td colspan="7" class="muted">No prescriptions in the live queue.</td></tr>'; return; }
  // Grouped by prescription type only - contains_cd stays a flag on the row, not a grouping.
  const groups=new Map();
  for(const r of rows){ const key=r.prescription_type; if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(r); }
  const orderedTypes = TYPE_ORDER.filter(t=>groups.has(t)).concat([...groups.keys()].filter(t=>!TYPE_ORDER.includes(t)));
  let html='';
  for(const type of orderedTypes){
    const list=groups.get(type);
    html += `<tr class="group-heading"><td colspan="7">${esc(typeLabel(type))} <span class="group-count">${list.length}</span></td></tr>`;
    html += list.map(renderQueueRow).join('');
  }
  $('queue-body').innerHTML=html;
  document.querySelectorAll('[data-open-rx]').forEach(tr=>tr.addEventListener('click',()=>openPrescription(tr.dataset.openRx)));
}
$('refresh-btn').addEventListener('click',loadQueue); $('dispensary-filter').addEventListener('change',loadQueue);

$('book-form').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!can('perm_book_in')){ toast('You do not have permission to book prescriptions in',true); return; }
  if(!$('book-ward').value){ toast('Please select a ward',true); return; }
  const neededByVal = $('book-needed-by').value;
  const args={p_dispensary_id:$('book-dispensary').value,p_hospital_number:$('book-hn').value,p_patient_initials:$('book-initials').value||null,p_ward_id:$('book-ward').value,p_prescription_type:$('book-type').value,p_item_count:$('book-items').value?Number($('book-items').value):null,p_contains_cd:$('book-cd').checked,p_notes:$('book-notes').value||null,p_needed_by:neededByVal?new Date(neededByVal).toISOString():null};
  const {data,error}=await sb.rpc('book_in_prescription',args); if(error){toast(error.message,true);return;} e.target.reset(); fillSelects(); toast(`Prescription #${data.display_id} booked in`); await loadQueue(); document.querySelector('[data-view="dashboard"]').click();
});

async function openPrescription(id){
  const {data:rx,error}=await sb.from('prescription_queue_view').select('*').eq('id',id).single();
  if(error){toast(error.message,true);return;} state.currentRx=rx; $('rx-title').textContent=`Prescription #${rx.display_id}`; $('rx-subtitle').textContent=`${rx.site_name} · ${rx.dispensary_name}`;
  const details=[['Hospital number',rx.hospital_number],['Patient initials',rx.patient_initials||'—'],['Ward',rx.ward_name||'—'],['Type',rx.prescription_type.toUpperCase()],['Items',rx.item_count??'—'],['Current stage',rx.stage_name],['State',rx.state],['Received',fmt(rx.received_at)]];
  if(rx.needed_by) details.push(['Needed by',fmt(rx.needed_by)]);
  const neededOverdue = rx.needed_by && rx.state==='active' && new Date(rx.needed_by) < new Date();
  $('rx-summary').innerHTML=details.map(([a,b])=>`<div class="detail${a==='Needed by'&&neededOverdue?' detail-overdue':''}"><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join('');
  await renderActions(rx); await loadTimeline(id);
  $('correction-panel').classList.toggle('hidden',!can('perm_progress_pharmacist'));
  $('rx-dialog').showModal();
}
async function renderActions(rx){
  const box=$('rx-actions'); box.innerHTML='';
  if(rx.state==='active'){
    const idx=state.stages.findIndex(s=>s.id===rx.current_stage_id); const next=state.stages[idx+1];
    if(next){
      const allowed = next.requires_role ? can('perm_progress_pharmacist') : can('perm_progress_standard');
      if(allowed){ const b=document.createElement('button'); b.className='btn primary'; b.textContent=`Move to ${next.name}`; b.onclick=(ev)=>{ev.stopPropagation();advance(rx.id,next.code);}; box.appendChild(b); }
    }
    if(can('perm_suspend_resume')){ const s=document.createElement('button');s.className='btn danger';s.textContent='Suspend';s.onclick=(ev)=>{ev.stopPropagation(); $('suspend-panel').classList.remove('hidden'); syncSuspendOtherRequirement(); };box.appendChild(s); }
  } else if(rx.state==='suspended' && can('perm_suspend_resume')){
    const b=document.createElement('button');b.className='btn primary';b.textContent='Resume';b.onclick=(ev)=>{ev.stopPropagation();resume(rx.id);};box.appendChild(b);
  } else if(rx.state==='ready' && can('perm_progress_standard')){
    const b=document.createElement('button');b.className='btn primary';b.textContent='Mark collected / dispatched';b.onclick=(ev)=>{ev.stopPropagation();collect(rx.id);};box.appendChild(b);
  }
}
async function advance(id,code){ const {error}=await sb.rpc('advance_prescription',{p_prescription_id:id,p_to_stage_code:code}); if(error){toast(error.message,true);return;} toast('Workflow updated'); await refreshOpen(id); }
async function resume(id){ const {error}=await sb.rpc('resume_prescription',{p_prescription_id:id}); if(error){toast(error.message,true);return;} toast('Prescription resumed'); await refreshOpen(id); }
async function collect(id){ const {error}=await sb.rpc('mark_collected',{p_prescription_id:id}); if(error){toast(error.message,true);return;} toast('Prescription completed'); $('rx-dialog').close(); await loadQueue(); }

function syncSuspendOtherRequirement(){
  const sel=$('suspend-reason'); const label=sel.selectedOptions[0]?.textContent||'';
  const isOther=label.trim()==='Other';
  $('suspend-note').required=isOther;
  $('suspend-note').placeholder = isOther ? 'Please give details (required)' : "Note (required if 'Other')";
}
$('suspend-reason').addEventListener('change', syncSuspendOtherRequirement);
$('suspend-btn').addEventListener('click',async()=>{
  if(!state.currentRx)return;
  const sel=$('suspend-reason'); const label=(sel.selectedOptions[0]?.textContent||'').trim(); const note=$('suspend-note').value.trim();
  if(label==='Other' && !note){ toast('Please give details when suspending for "Other"',true); return; }
  const {error}=await sb.rpc('suspend_prescription',{p_prescription_id:state.currentRx.id,p_reason_id:sel.value,p_free_text:note||null});
  if(error){toast(error.message,true);return;} $('suspend-panel').classList.add('hidden');$('suspend-note').value='';toast('Prescription suspended');await refreshOpen(state.currentRx.id);
});
$('correct-btn').addEventListener('click',async()=>{ if(!state.currentRx)return; const hn=$('correct-hn').value.trim(),reason=$('correct-reason').value.trim(); if(!hn||reason.length<3){toast('New hospital number and correction reason are required',true);return;} const {error}=await sb.rpc('correct_hospital_number',{p_prescription_id:state.currentRx.id,p_new_hospital_number:hn,p_reason:reason}); if(error){toast(error.message,true);return;} $('correct-hn').value='';$('correct-reason').value='';toast('Hospital number corrected and audited');await refreshOpen(state.currentRx.id); });
async function refreshOpen(id){ await loadQueue(); await openPrescriptionDataOnly(id); }
async function openPrescriptionDataOnly(id){ const {data}=await sb.from('prescription_queue_view').select('*').eq('id',id).single(); if(!data){$('rx-dialog').close();return;} state.currentRx=data;$('rx-title').textContent=`Prescription #${data.display_id}`;$('rx-summary').querySelector('.detail strong').textContent=data.hospital_number;await renderActions(data);await loadTimeline(id); }

// Human-readable summary of an event's details, instead of a raw JSON dump.
function eventDetailText(e){
  const d = e.details || {};
  switch(e.event_type){
    case 'BOOKED_IN': return d.needed_by ? `Needed by ${fmt(d.needed_by)}` : '';
    case 'SUSPENDED': return [d.reason_name, d.note].filter(Boolean).join(' — ');
    case 'HOSPITAL_NUMBER_CORRECTED': return `${d.old||''} → ${d.new||''}${d.reason?` — ${d.reason}`:''}`;
    default: return '';
  }
}
async function loadTimeline(id){
  const {data,error}=await sb.from('prescription_events').select('*,from_stage:from_stage_id(name),to_stage:to_stage_id(name),profiles:performed_by(display_name)').eq('prescription_id',id).order('performed_at',{ascending:false});
  if(error){$('timeline').innerHTML=`<p class="error-text">${esc(error.message)}</p>`;return;}
  $('timeline').innerHTML=(data||[]).map(e=>{
    const extra=eventDetailText(e);
    return `<div class="timeline-item"><strong>${esc(eventLabel(e))}</strong><small>${fmt(e.performed_at)} · ${esc(e.profiles?.display_name||'Unknown user')}</small>${extra?`<div class="muted tiny">${esc(extra)}</div>`:''}</div>`;
  }).join('')||'<p class="muted">No events.</p>';
}
function eventLabel(e){ return ({BOOKED_IN:'Booked in',STAGE_ADVANCED:`Moved to ${e.to_stage?.name||'next stage'}`,SUSPENDED:'Suspended',RESUMED:'Resumed',COLLECTED:'Collected / dispatched',HOSPITAL_NUMBER_CORRECTED:'Hospital number corrected'})[e.event_type]||e.event_type.replaceAll('_',' '); }
$('rx-close').addEventListener('click',()=>$('rx-dialog').close());

$('history-btn').addEventListener('click',searchHistory); $('history-search').addEventListener('keydown',e=>{if(e.key==='Enter')searchHistory()});
async function searchHistory(){
  let q=sb.from('prescription_queue_view').select('*').order('received_at',{ascending:false}).limit(200); const term=$('history-search').value.trim(); const st=$('history-state').value;
  if(st) q=q.eq('state',st); if(term){ if(/^#?\d+$/.test(term)&&term.replace('#','').length<10) q=q.eq('display_id',Number(term.replace('#',''))); else q=q.ilike('hospital_number',`%${term.replace(/[%_,]/g,'')}%`); }
  const {data,error}=await q; if(error){toast(error.message,true);return;}
  $('history-body').innerHTML=(data||[]).map(r=>`<tr class="row-clickable" data-open-rx="${r.id}"><td>#${r.display_id}</td><td>${esc(r.hospital_number)}</td><td>${esc(r.ward_name||'—')}</td><td><span class="state-pill">${esc(r.state)}</span></td><td>${esc(r.stage_name)}</td><td>${fmt(r.received_at)}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No results.</td></tr>';
  document.querySelectorAll('#history-body [data-open-rx]').forEach(tr=>tr.addEventListener('click',()=>openPrescription(tr.dataset.openRx)));
}

/* ---------- Responsible Pharmacist ---------- */
async function loadRP(){
  const {data,error}=await sb.from('current_rp_view').select('*');
  if(error){ $('rp-strip').innerHTML=`<div class="rp-chip"><span class="rp-dot unset"></span><span class="rp-none">Responsible Pharmacist status unavailable (${esc(error.message)})</span></div>`; return; }
  state.rpSessions=data||[]; renderRPStrip();
}
function renderRPStrip(){
  const box=$('rp-strip');
  if(!state.sites.length){ box.innerHTML='<div class="rp-chip"><span class="rp-dot unset"></span><span class="rp-none">No hospital sites configured yet — add one from Configuration to show Responsible Pharmacist status here</span></div>'; return; }
  const chips = state.sites.map(s=>{
    const rp = state.rpSessions.find(r=>r.site_id===s.id);
    const nameHtml = rp ? `${esc(rp.pharmacist_name)}${rp.gphc_number?` <span class="rp-gphc">GPhC ${esc(rp.gphc_number)}</span>`:''}` : 'Not signed in';
    return `<div class="rp-chip"><span class="rp-dot ${rp?'set':'unset'}"></span><span class="rp-site">RP ${esc(s.name)}</span><span class="${rp?'rp-name':'rp-none'}">${nameHtml}</span></div>`;
  }).join('');
  let controls='';
  if(can('perm_responsible_pharmacist')){
    const mine = state.rpSessions.find(r=>r.pharmacist_id===state.profile.id);
    controls = mine
      ? `<button id="rp-signout-btn" class="btn ghost" data-site="${mine.site_id}">Sign out as RP (${esc(mine.site_name)})</button>`
      : `<select id="rp-site-select">${state.sites.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><button id="rp-signin-btn" class="btn secondary">Sign in as RP</button>`;
  }
  box.innerHTML = chips + controls;
  if($('rp-signin-btn')) $('rp-signin-btn').addEventListener('click', async()=>{ const {error}=await sb.rpc('rp_sign_in',{p_site_id:$('rp-site-select').value}); if(error){toast(error.message,true);return;} toast('Signed in as Responsible Pharmacist'); await loadRP(); });
  if($('rp-signout-btn')) $('rp-signout-btn').addEventListener('click', async(e)=>{ const {error}=await sb.rpc('rp_sign_out',{p_site_id:e.target.dataset.site}); if(error){toast(error.message,true);return;} toast('Signed out as Responsible Pharmacist'); await loadRP(); });
}

/* ---------- Users control panel ---------- */
async function loadUsers(){
  const {data,error}=await sb.from('profiles').select('*').order('display_name'); if(error){toast(error.message,true);return;}
  state.users=data||[];
  $('users-body').innerHTML=(data||[]).map(u=>{
    const badges = u.is_superuser
      ? '<span class="perm-badge super">Superuser — all access</span>'
      : (ALL_PERMS.filter(p=>u[p.key]).map(p=>`<span class="perm-badge">${esc(p.label)}</span>`).join('') || '<span class="perm-badge off">No permissions</span>');
    const manageBtn = (u.id===state.profile.id || u.is_superuser) ? '' : `<button class="btn ghost" data-manage-user="${u.id}">Manage</button>`;
    const roleLabel = u.is_superuser ? 'Superuser' : (ROLE_LABELS[u.role]||u.role);
    return `<tr><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td><td>${esc(roleLabel)}</td><td>${esc(u.gphc_number||'—')}</td><td>${u.active?'Yes':'No'}</td><td><div class="perm-badges">${badges}</div></td><td>${manageBtn}</td></tr>`;
  }).join('');
  document.querySelectorAll('[data-manage-user]').forEach(b=>b.addEventListener('click',()=>openManageUser(b.dataset.manageUser)));
}

$('create-user-form').addEventListener('submit',async e=>{
  e.preventDefault(); const ids=[...$('user-dispensaries').querySelectorAll('input:checked')].map(x=>x.value);
  const role=$('user-role').value; const gphc=$('user-gphc').value.trim();
  if(role==='pharmacist' && !gphc){ toast('GPhC number is required for a Pharmacist account',true); return; }
  const permissions = collectPerms('up');
  const {data,error}=await sb.functions.invoke('create-user',{body:{username:$('user-username').value,display_name:$('user-display').value,role,password:$('user-password').value,dispensary_ids:ids,permissions,gphc_number:gphc||null}});
  if(error||data?.error){toast(data?.error||error.message,true);return;}
  e.target.reset(); document.querySelectorAll('#user-perms-clinical input').forEach(c=>c.checked=false); syncRoleDependentUI('up');
  toast(`User ${data.username} created`);await loadUsers();
});

async function openManageUser(id){
  const u=state.users.find(x=>x.id===id); if(!u) return;
  state.managingUserId=id;
  $('manage-user-name').textContent=`${u.username} · ${u.display_name}`;
  $('mu-display').value=u.display_name; $('mu-role').value=u.role; $('mu-active').checked=u.active; $('mu-password').value=''; $('mu-gphc').value=u.gphc_number||'';
  TICKABLE_PERMS.forEach(p=>{ const el=document.getElementById(`mu-${p.key}`); if(el) el.checked=!!u[p.key]; });
  syncRoleDependentUI('mu');
  const {data:access}=await sb.from('user_dispensary_access').select('dispensary_id').eq('user_id',id);
  const accessIds=new Set((access||[]).map(a=>a.dispensary_id));
  $('mu-dispensaries').innerHTML=state.dispensaries.map(d=>`<label><input type="checkbox" value="${d.id}" ${accessIds.has(d.id)?'checked':''}> ${esc(d.name)}</label>`).join('');
  $('manage-user-dialog').showModal();
}
$('manage-user-close').addEventListener('click',()=>$('manage-user-dialog').close());
$('manage-user-form').addEventListener('submit', async e=>{
  e.preventDefault(); const id=state.managingUserId; if(!id) return;
  const role=$('mu-role').value; const gphc=$('mu-gphc').value.trim();
  if(role==='pharmacist' && !gphc){ toast('GPhC number is required for a Pharmacist account',true); return; }
  const ids=[...$('mu-dispensaries').querySelectorAll('input:checked')].map(x=>x.value);
  const permissions=collectPerms('mu');
  const body={ user_id:id, display_name:$('mu-display').value, role, active:$('mu-active').checked, dispensary_ids:ids, permissions, gphc_number:gphc };
  if($('mu-password').value) body.password=$('mu-password').value;
  const {data,error}=await sb.functions.invoke('manage-user',{body});
  if(error||data?.error){toast(data?.error||error.message,true);return;}
  toast('User updated'); $('manage-user-dialog').close(); await loadUsers();
});

/* ---------- Configuration: manual add ---------- */
$('site-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('sites').insert({name:$('site-name').value.trim(),created_by:state.profile.id});if(error){toast(error.message,true);return;}e.target.reset();toast('Site added');await loadReference();await loadRP();});
$('disp-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('dispensaries').insert({site_id:$('disp-site').value,name:$('disp-name').value.trim(),created_by:state.profile.id});if(error){toast(error.message,true);return;}e.target.reset();toast('Dispensary added');await loadReference();});
$('ward-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('wards').insert({site_id:$('ward-site').value,name:$('ward-name').value.trim()});if(error){toast(error.message,true);return;}e.target.reset();toast('Ward/location added');await loadReference();});

/* ---------- Configuration: KPI turnaround targets (hours + minutes, per type) ---------- */
function hm(mins){ return mins==null ? {h:'',m:''} : {h:Math.floor(mins/60), m:mins%60}; }
async function loadKpiRules(){
  const {data,error}=await sb.from('kpi_rules').select('*').eq('active',true);
  if(error){ $('kpi-body').innerHTML=`<tr><td colspan="4" class="error-text">${esc(error.message)}</td></tr>`; return; }
  state.kpiRules=data||[]; renderKpiRules();
}
function renderKpiRules(){
  $('kpi-body').innerHTML = TYPE_ORDER.map(type=>{
    const rule = state.kpiRules.find(k=>k.prescription_type===type);
    const a=hm(rule?.amber_minutes), r=hm(rule?.red_minutes);
    return `<tr data-kpi-type="${type}">
      <td>${esc(typeLabel(type))}</td>
      <td class="filters"><input type="number" min="0" class="kpi-h kpi-amber-h" value="${a.h}" placeholder="h" style="width:56px">h <input type="number" min="0" max="59" class="kpi-m kpi-amber-m" value="${a.m}" placeholder="m" style="width:56px">m</td>
      <td class="filters"><input type="number" min="0" class="kpi-h kpi-red-h" value="${r.h}" placeholder="h" style="width:56px">h <input type="number" min="0" max="59" class="kpi-m kpi-red-m" value="${r.m}" placeholder="m" style="width:56px">m</td>
      <td class="filters"><button class="btn secondary" data-kpi-save="${type}">Save</button>${rule?`<button class="btn ghost" data-kpi-clear="${type}">Reset to default</button>`:''}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('[data-kpi-save]').forEach(b=>b.addEventListener('click',()=>saveKpiRule(b.dataset.kpiSave)));
  document.querySelectorAll('[data-kpi-clear]').forEach(b=>b.addEventListener('click',()=>clearKpiRule(b.dataset.kpiClear)));
}
async function saveKpiRule(type){
  const row=document.querySelector(`tr[data-kpi-type="${type}"]`);
  const ah=Number(row.querySelector('.kpi-amber-h').value)||0, am=Number(row.querySelector('.kpi-amber-m').value)||0;
  const rh=Number(row.querySelector('.kpi-red-h').value)||0, rm=Number(row.querySelector('.kpi-red-m').value)||0;
  const amber=ah*60+am, red=rh*60+rm;
  if(amber<=0 || red<=0){ toast('Enter a turnaround time greater than zero for both amber and red',true); return; }
  if(red<=amber){ toast('Red must be a longer turnaround than amber',true); return; }
  const existing=state.kpiRules.find(k=>k.prescription_type===type);
  const {error}=existing
    ? await sb.from('kpi_rules').update({amber_minutes:amber,red_minutes:red,active:true}).eq('id',existing.id)
    : await sb.from('kpi_rules').insert({prescription_type:type,priority:null,amber_minutes:amber,red_minutes:red,active:true,created_by:state.profile.id});
  if(error){ toast(error.message,true); return; }
  toast(`Turnaround target saved for ${typeLabel(type)}`); await loadKpiRules(); await loadQueue();
}
async function clearKpiRule(type){
  const existing=state.kpiRules.find(k=>k.prescription_type===type); if(!existing) return;
  const {error}=await sb.from('kpi_rules').delete().eq('id',existing.id);
  if(error){ toast(error.message,true); return; }
  toast(`${typeLabel(type)} reverted to the general default`); await loadKpiRules(); await loadQueue();
}

/* ---------- Configuration: Excel import of sites & wards ---------- */
function parseImportFile(file){
  const reader=new FileReader();
  reader.onload=(ev)=>{
    try{
      const data=new Uint8Array(ev.target.result);
      const wb=XLSX.read(data,{type:'array'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const json=XLSX.utils.sheet_to_json(ws,{defval:''});
      state.importRows=json.map(r=>{
        const keys=Object.keys(r);
        const siteKey=keys.find(k=>/^site|hospital$/i.test(String(k).trim()));
        const wardKey=keys.find(k=>/^ward|location$/i.test(String(k).trim()));
        return {site:String(r[siteKey!==undefined?siteKey:'Site']||'').trim(), ward:String(r[wardKey!==undefined?wardKey:'Ward']||'').trim()};
      }).filter(r=>r.site);
      renderImportPreview();
    }catch(err){ toast('Could not read that file — check it is a valid spreadsheet',true); }
  };
  reader.readAsArrayBuffer(file);
}
function renderImportPreview(){
  const existingSiteNames=new Set(state.sites.map(s=>s.name.toLowerCase()));
  const wardKey=(siteName,wardName)=>`${siteName.toLowerCase()}::${wardName.toLowerCase()}`;
  const existingWardKeys=new Set(state.wards.map(w=>wardKey((state.sites.find(s=>s.id===w.site_id)||{}).name||'',w.name)));
  const rowsHtml=state.importRows.map(r=>{
    const siteNew=!existingSiteNames.has(r.site.toLowerCase());
    const wardNew=r.ward && !existingWardKeys.has(wardKey(r.site,r.ward));
    const status = r.ward ? `${siteNew?'New site':'Existing site'} · ${wardNew?'New ward':'Existing ward'}` : `${siteNew?'New site':'Existing site'} (no ward)`;
    return `<tr><td>${esc(r.site)}</td><td>${esc(r.ward||'—')}</td><td>${esc(status)}</td></tr>`;
  }).join('');
  $('import-preview').innerHTML=`<table><thead><tr><th>Site</th><th>Ward</th><th>Status</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  $('import-preview').classList.remove('hidden'); $('import-actions').classList.remove('hidden');
  $('import-summary').textContent=`${state.importRows.length} row(s) parsed`;
}
$('import-file').addEventListener('change', e=>{ const f=e.target.files[0]; if(f) parseImportFile(f); });
const importDrop=$('import-drop');
['dragenter','dragover'].forEach(evt=>importDrop.addEventListener(evt,e=>{e.preventDefault();importDrop.classList.add('drag');}));
['dragleave','drop'].forEach(evt=>importDrop.addEventListener(evt,e=>{e.preventDefault();importDrop.classList.remove('drag');}));
importDrop.addEventListener('drop', e=>{ const f=e.dataTransfer.files[0]; if(f) parseImportFile(f); });
$('import-template-btn').addEventListener('click', ()=>{
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.aoa_to_sheet([['Site','Ward'],['Worthing Hospital','Example Ward A'],['Worthing Hospital','Example Ward B'],["St Richard's Hospital",'']]);
  XLSX.utils.book_append_sheet(wb,ws,'Sites and Wards'); XLSX.writeFile(wb,'sites-wards-template.xlsx');
});
$('import-commit-btn').addEventListener('click', async ()=>{
  if(!state.importRows.length){toast('Nothing to import',true);return;}
  const siteMap=new Map(state.sites.map(s=>[s.name.toLowerCase(),s.id]));
  let added=0, skipped=0, failed=0;
  for(const siteName of [...new Set(state.importRows.map(r=>r.site))]){
    if(siteMap.has(siteName.toLowerCase())) continue;
    const {data,error}=await sb.from('sites').insert({name:siteName,created_by:state.profile.id}).select('id,name').single();
    if(error){ toast(`Site "${siteName}" failed: ${error.message}`,true); failed++; continue; }
    siteMap.set(siteName.toLowerCase(),data.id); added++;
  }
  const wardKeySet=new Set(state.wards.map(w=>`${w.site_id}::${w.name.toLowerCase()}`));
  for(const row of state.importRows){
    if(!row.ward) continue;
    const siteId=siteMap.get(row.site.toLowerCase()); if(!siteId){ skipped++; continue; }
    const key=`${siteId}::${row.ward.toLowerCase()}`; if(wardKeySet.has(key)){ skipped++; continue; }
    const {error}=await sb.from('wards').insert({site_id:siteId,name:row.ward});
    if(error){ toast(`Ward "${row.ward}" failed: ${error.message}`,true); failed++; continue; }
    wardKeySet.add(key); added++;
  }
  toast(`Import complete — ${added} added, ${skipped} already existed${failed?`, ${failed} failed`:''}`);
  state.importRows=[]; $('import-preview').classList.add('hidden'); $('import-actions').classList.add('hidden'); $('import-file').value='';
  await loadReference();
});

/* ---------- Audit ---------- */
async function loadAudit(){
  let q=sb.from('audit_log').select('*,profiles:actor_id(display_name)').order('created_at',{ascending:false}).limit(300);
  const term=$('audit-search').value.trim(); if(term) q=q.ilike('hospital_number',`%${term.replace(/[%_,]/g,'')}%`);
  const {data,error}=await q; if(error){toast(error.message,true);return;}
  $('audit-body').innerHTML=(data||[]).map(a=>`<tr><td>${fmt(a.created_at)}</td><td>${esc(a.action)}</td><td>${esc(a.hospital_number||'—')}</td><td>${esc(a.entity_type)} ${esc(a.entity_id||'')}</td><td>${esc(a.profiles?.display_name||'—')}</td><td><code>${esc(JSON.stringify(a.details||{}))}</code></td></tr>`).join('')||'<tr><td colspan="6" class="muted">No audit entries.</td></tr>';
}
$('audit-search-btn').addEventListener('click',loadAudit);
$('audit-search').addEventListener('keydown',e=>{if(e.key==='Enter')loadAudit();});
$('audit-clear-btn').addEventListener('click',()=>{$('audit-search').value='';loadAudit();});

function subscribeRealtime(){
  if(state.realtime) sb.removeChannel(state.realtime);
  state.realtime=sb.channel('prescription-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'prescriptions'},()=>loadQueue())
    .on('postgres_changes',{event:'*',schema:'public',table:'rp_sessions'},()=>loadRP())
    .subscribe();
}

init();
