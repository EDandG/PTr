/* Prescription Tracker v1.8 - static GitHub Pages client */
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
  {key:'perm_progress_standard', label:'Progress ordinary workflow stages', hint:'Awaiting Screening through to Awaiting Final Check'},
  {key:'perm_progress_pharmacist', label:"Change status to 'Checked'", hint:'Pharmacist sign-off — the final check stage. Also allows correcting hospital numbers.'},
  {key:'perm_suspend', label:'Suspend prescriptions', hint:"Includes choosing a suspension reason; 'Other' needs a note"},
  {key:'perm_resume', label:'Resume prescriptions', hint:'Bring a suspended prescription back to active'},
  {key:'perm_view_all_dispensaries', label:'View all dispensaries', hint:'Not limited to allocated dispensaries'},
];
const RP_PERM = {key:'perm_responsible_pharmacist', label:'Responsible Pharmacist eligible', hint:'Pharmacist role only — requires a GPhC number'};
const TICKABLE_PERMS = CLINICAL_PERMS.concat([RP_PERM]);
const AUTO_PERMS = [
  {key:'perm_manage_users', label:'Manage users'},
  {key:'perm_manage_config', label:'Configure sites/wards, incl. import'},
  {key:'perm_view_audit', label:'View governance audit log'},
];
const ALL_PERMS = TICKABLE_PERMS.concat(AUTO_PERMS);

const state = {
  session:null, profile:null, dispensaries:[], dispensarySites:[], sites:[], wards:[], stages:[],
  suspensionReasons:[], prescriptionTypes:[], currentRx:null, realtime:null, users:[], rpSessions:[],
  managingUserId:null, importRows:[], queueRows:[]
};
const $ = (id) => document.getElementById(id);
const esc = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = (d) => d ? new Intl.DateTimeFormat('en-GB',{dateStyle:'short',timeStyle:'short'}).format(new Date(d)) : '—';
const can = (permKey) => !!(state.profile?.is_superuser || state.profile?.[permKey]);
function toast(msg, error=false){ const t=$('toast'); t.textContent=msg; t.className='toast'+(error?' error':''); setTimeout(()=>t.classList.add('hidden'),3500); }
function usernameEmail(username){ return `${String(username).toLowerCase().trim()}@${cfg.USERNAME_DOMAIN || 'users.local'}`; }
function hm(mins){ return mins==null ? {h:'',m:''} : {h:Math.floor(mins/60), m:mins%60}; }
function slugify(name){
  const base = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'item';
  return base;
}

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

let queueTickTimer=null;
function showLogin(){ state.session=null; state.profile=null; if(queueTickTimer){ clearInterval(queueTickTimer); queueTickTimer=null; } $('app').classList.add('hidden'); $('login-screen').classList.remove('hidden'); }
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

/* ---------- Searchable dropdowns ---------- */
// Wraps a native <select> with a type-to-filter text input. Reads the
// select's live option list each time it opens, so any code elsewhere that
// rebuilds the select's innerHTML (fillSelects, filters, etc.) just works
// without needing to notify this wrapper separately.
function makeSearchable(selectId, placeholder){
  const select=document.getElementById(selectId);
  if(!select || select.dataset.searchableInit) return;
  select.dataset.searchableInit='1';
  select.classList.add('searchable-native');
  const wrap=document.createElement('div'); wrap.className='searchable';
  const input=document.createElement('input'); input.type='text'; input.className='searchable-input'; input.autocomplete='off';
  input.placeholder=placeholder||'Search…';
  const panel=document.createElement('div'); panel.className='searchable-panel hidden';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(input); wrap.appendChild(panel); wrap.appendChild(select);

  function labelFor(value){ const o=[...select.options].find(o=>o.value===value); return o?o.textContent:''; }
  function sync(){ input.value=labelFor(select.value); input.disabled=select.disabled; }
  function open(filterText){
    const f=(filterText||'').trim().toLowerCase();
    const opts=[...select.options].filter(o=>!o.disabled).filter(o=>!f||o.textContent.toLowerCase().includes(f));
    panel.innerHTML = opts.length ? opts.map(o=>`<div class="searchable-option${o.value===select.value?' active':''}" data-value="${esc(o.value)}">${esc(o.textContent)}</div>`).join('') : '<div class="searchable-empty">No matches</div>';
    panel.classList.remove('hidden');
    panel.querySelectorAll('.searchable-option').forEach(el=>el.addEventListener('mousedown', e=>{
      e.preventDefault();
      select.value=el.dataset.value; sync(); panel.classList.add('hidden');
      select.dispatchEvent(new Event('change',{bubbles:true}));
    }));
  }
  input.addEventListener('focus', ()=>{ if(select.disabled) return; input.value=''; open(''); });
  input.addEventListener('input', ()=>open(input.value));
  input.addEventListener('blur', ()=>setTimeout(()=>{ panel.classList.add('hidden'); sync(); }, 120));
  input.addEventListener('keydown', e=>{ if(e.key==='Escape'){ panel.classList.add('hidden'); sync(); input.blur(); } });
  select.addEventListener('change', sync);
  select._searchableSync = sync;
  sync();
}
const SEARCHABLE_IDS = ['book-ward','book-site','book-dispensary','dispensary-filter','ward-site','book-type','suspend-reason'];
function syncAllSearchables(){ SEARCHABLE_IDS.forEach(id=>document.getElementById(id)?._searchableSync?.()); }
SEARCHABLE_IDS.forEach(id=>makeSearchable(id));

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
  const [d,ds,s,w,st,sr,pt] = await Promise.all([
    sb.from('dispensaries').select('*').eq('active',true).order('name'),
    sb.from('dispensary_sites').select('*'),
    sb.from('sites').select('*').eq('active',true).order('name'),
    sb.from('wards').select('*').eq('active',true).order('name'),
    sb.from('workflow_stages').select('*').eq('active',true).order('sequence'),
    sb.from('suspension_reasons').select('*').eq('active',true).order('name'),
    sb.from('prescription_types').select('*').eq('active',true).order('sort_order')
  ]);
  state.dispensaries=d.data||[]; state.dispensarySites=ds.data||[]; state.sites=s.data||[]; state.wards=w.data||[];
  state.stages=st.data||[]; state.suspensionReasons=sr.data||[]; state.prescriptionTypes=pt.data||[];
  fillSelects();
  if(can('perm_manage_users')) await loadUsers();
  if(can('perm_manage_config')){ renderDispensarySites(); renderPrescriptionTypes(); renderSuspensionReasons(); }
}
function dispensaryLabel(d, withSites){
  if(!withSites) return d.name;
  const names = state.dispensarySites.filter(ds=>ds.dispensary_id===d.id).map(ds=>(state.sites.find(s=>s.id===ds.site_id)||{}).name).filter(Boolean);
  return names.length ? `${d.name} (${names.join(', ')})` : d.name;
}
function fillSelects(){
  const dispOpts=state.dispensaries.map(d=>`<option value="${d.id}">${esc(dispensaryLabel(d,true))}</option>`).join('');
  $('dispensary-filter').innerHTML='<option value="">All dispensaries</option>'+dispOpts;
  $('book-dispensary').innerHTML=dispOpts;
  const siteOpts=state.sites.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('ward-site').innerHTML=siteOpts;
  $('book-site').innerHTML='<option value="" disabled selected>Select hospital/unit…</option>'+siteOpts;
  filterBookWardBySite(null);
  $('suspend-reason').innerHTML=state.suspensionReasons.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('');
  syncSuspendOtherRequirement();
  $('user-dispensaries').innerHTML=state.dispensaries.map(d=>`<label><input type="checkbox" value="${d.id}"> ${esc(d.name)}</label>`).join('');
  const defaultType = state.prescriptionTypes.find(t=>t.is_default) || state.prescriptionTypes[0];
  $('book-type').innerHTML = state.prescriptionTypes.map(t=>`<option value="${t.id}" ${defaultType&&t.id===defaultType.id?'selected':''}>${esc(t.name)}</option>`).join('');
  syncAllSearchables();
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
  const list = state.dispensaries.filter(d=>!siteId || state.dispensarySites.some(ds=>ds.dispensary_id===d.id && ds.site_id===siteId));
  $('book-dispensary').innerHTML = list.map(d=>`<option value="${d.id}">${esc(dispensaryLabel(d, !siteId))}</option>`).join('');
  syncAllSearchables();
}
function filterBookWardBySite(siteId){
  const list = state.wards.filter(w=>!siteId||w.site_id===siteId);
  const wardSel=$('book-ward');
  if(!siteId){
    wardSel.innerHTML='<option value="">No ward — book directly to the hospital/unit</option>';
    wardSel.disabled=false;
  } else if(!list.length){
    wardSel.innerHTML='<option value="">No wards for this hospital/unit</option>';
    wardSel.disabled=true;
  } else {
    wardSel.disabled=false;
    wardSel.innerHTML='<option value="" disabled selected>Select a ward…</option>'+list.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('');
  }
  syncAllSearchables();
}
$('book-ward').addEventListener('change', ()=>{
  const wardId=$('book-ward').value; if(!wardId) return;
  const ward=state.wards.find(w=>w.id===wardId); if(!ward) return;
  $('book-site').value=ward.site_id; $('book-site')._searchableSync?.();
  filterBookDispensaryBySite(ward.site_id);
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
// Computed from received_at + that type's own KPI (amber_minutes/red_minutes
// come straight off the prescription_types row via the view), so every
// signed-in user's browser can keep it ticking live between reloads.
function liveKpi(r){
  if(r.state!=='active' || !r.red_minutes) return null;
  // Excludes accumulated suspended time (fixed as of the last reload) so
  // the live ticker matches the paused/resumed elapsed the server computes
  // - a prescription that was suspended and resumed doesn't count that
  // paused stretch against it.
  const suspendedSec = r.suspended_seconds || 0;
  const elapsedMin = Math.max(0, Math.floor(((Date.now() - new Date(r.received_at).getTime())/1000 - suspendedSec)/60));
  let colour='green';
  if(elapsedMin>=r.red_minutes) colour='red';
  else if(r.amber_minutes!=null && elapsedMin>=r.amber_minutes) colour='amber';
  const pct = Math.max(0, Math.min(100, (elapsedMin/r.red_minutes)*100));
  return {elapsedMin, colour, pct};
}
// Formats a minute count as "Xh Ym" (or just "Ym" under an hour).
function formatDuration(mins){
  mins = Math.max(0, Math.round(mins));
  const h = Math.floor(mins/60), m = mins%60;
  return h>0 ? `${h}h ${m}m` : `${m}m`;
}
const KPI_FILL_COLOURS = {green:'rgba(76,174,49,.24)', amber:'rgba(210,147,27,.26)', red:'rgba(191,59,50,.28)'};
function kpiFillStyle(r){
  const live=liveKpi(r); if(!live) return '';
  return ` style="background:linear-gradient(to right, ${KPI_FILL_COLOURS[live.colour]} ${live.pct}%, transparent ${live.pct}%)"`;
}
function renderQueueRow(r){
  const cls=['row-clickable']; if(r.state==='suspended') cls.push('row-suspended');
  // "Being dispensed by" only matters while it's actually the live claim -
  // i.e. still sitting in Awaiting dispensing with someone on it.
  const beingDispensedLine = (r.stage_code==='awaiting_labelling' && r.dispensing_started_by_name)
    ? `<br><small class="muted">Being dispensed by ${esc(r.dispensing_started_by_name)}</small>` : '';
  return `<tr class="${cls.join(' ')}"${kpiFillStyle(r)} data-open-rx="${r.id}">`+
    `<td data-label="ID">#${r.display_id}</td>`+
    `<td data-label="Hospital no."><strong>${esc(r.hospital_number)}</strong></td>`+
    `<td data-label="Ward">${esc(r.ward_name||'—')}</td>`+
    `<td data-label="Type">${esc(r.prescription_type_name||'—')}${r.contains_cd?' · CD':''}</td>`+
    `<td data-label="Items">${r.item_count??'—'}</td>`+
    `<td data-label="Stage">${esc(r.stage_name)}${r.state==='suspended'?' · Suspended':''}${r.needed_by?`<br><small class="muted">Needed by ${fmt(r.needed_by)}</small>`:''}${beingDispensedLine}</td>`+
    `<td data-label="Elapsed" class="elapsed-cell">${formatDuration(r.elapsed_minutes)}</td></tr>`;
}
// Which process bucket a row belongs to. Suspended items get pulled into
// their own section regardless of stage, since they need attention.
// "Awaiting dispensing" vs "Being dispensed" is the same underlying stage
// (awaiting_labelling) - the split is purely on whether it's been claimed.
const BUCKET_ORDER = ['suspended','awaiting_screening','awaiting_dispensing','being_dispensed','awaiting_final_check'];
const BUCKET_LABELS = {suspended:'Suspended', awaiting_screening:'Awaiting clinical screening', awaiting_dispensing:'Awaiting dispensing', being_dispensed:'Being dispensed', awaiting_final_check:'Awaiting final check'};
function processBucket(r){
  if(r.state==='suspended') return 'suspended';
  if(r.stage_code==='awaiting_labelling') return r.dispensing_started_by ? 'being_dispensed' : 'awaiting_dispensing';
  return r.stage_code;
}
function renderQueue(rows){
  state.queueRows=rows;
  $('sum-active').textContent=rows.filter(r=>r.state==='active').length; $('sum-suspended').textContent=rows.filter(r=>r.state==='suspended').length; $('sum-ready').textContent=rows.filter(r=>r.state==='ready').length;
  updateOverTargetTile();
  // Once a prescription is Checked (state 'ready') it comes off the live
  // queue immediately - it's done, and lives in History from then on.
  const displayRows = rows.filter(r=>r.state!=='ready');
  renderTilesByType(displayRows);
  if(!displayRows.length){ $('queue-body').innerHTML='<tr><td colspan="7" class="muted">No prescriptions in the live queue.</td></tr>'; startQueueTicker(); return; }
  const buckets=new Map();
  for(const r of displayRows){ const b=processBucket(r); if(!buckets.has(b)) buckets.set(b,[]); buckets.get(b).push(r); }
  const knownIds = state.prescriptionTypes.map(t=>t.id);
  let html='';
  for(const bucket of BUCKET_ORDER){
    const list=buckets.get(bucket); if(!list || !list.length) continue;
    html += `<tr class="bucket-heading"><td colspan="7">${esc(BUCKET_LABELS[bucket]||bucket)} <span class="group-count">${list.length}</span></td></tr>`;
    // Sub-grouped by type within each process section.
    const typeGroups=new Map();
    for(const r of list){ const key=r.prescription_type_id; if(!typeGroups.has(key)) typeGroups.set(key,[]); typeGroups.get(key).push(r); }
    const orderedIds = knownIds.filter(id=>typeGroups.has(id)).concat([...typeGroups.keys()].filter(id=>!knownIds.includes(id)));
    for(const id of orderedIds){
      const sub=typeGroups.get(id);
      const label = (state.prescriptionTypes.find(t=>t.id===id)||{}).name || sub[0]?.prescription_type_name || 'Other';
      html += `<tr class="group-heading" data-type-id="${id}"><td colspan="7">${esc(label)} <span class="group-count">${sub.length}</span></td></tr>`;
      html += sub.map(renderQueueRow).join('');
    }
  }
  $('queue-body').innerHTML=html;
  document.querySelectorAll('[data-open-rx]').forEach(tr=>tr.addEventListener('click',()=>openPrescription(tr.dataset.openRx)));
  startQueueTicker();
}
// Tiles-flyout breakdown by prescription type - click one to jump straight
// to that type's section in the live queue below.
function renderTilesByType(displayRows){
  const counts=new Map();
  for(const r of displayRows){ counts.set(r.prescription_type_id, (counts.get(r.prescription_type_id)||0)+1); }
  const rowsHtml = state.prescriptionTypes.map(t=>{
    const n=counts.get(t.id)||0;
    return `<button type="button" class="tiles-by-type-row" data-jump-type="${t.id}"><span>${esc(t.name)}</span><strong>${n}</strong></button>`;
  }).join('');
  $('tiles-by-type').innerHTML = rowsHtml || '<p class="muted tiny">No prescription types configured yet.</p>';
  document.querySelectorAll('[data-jump-type]').forEach(b=>b.addEventListener('click', ()=>{
    document.querySelector('[data-view="dashboard"]').click();
    $('tiles-flyout').classList.remove('open');
    requestAnimationFrame(()=>{
      const target=document.querySelector(`[data-type-id="${b.dataset.jumpType}"]`);
      if(target) target.scrollIntoView({behavior:'smooth', block:'start'});
      else toast('Nothing of that type in the live queue right now');
    });
  }));
}
function updateOverTargetTile(){
  const overTarget = (state.queueRows||[]).filter(r=>{ const live=liveKpi(r); return live && live.colour==='red'; }).length;
  $('sum-red').textContent = overTarget;
}
function startQueueTicker(){ if(queueTickTimer) clearInterval(queueTickTimer); queueTickTimer=setInterval(tickQueueBars, 10000); }
function tickQueueBars(){
  if(!state.queueRows || !state.queueRows.length) return;
  for(const r of state.queueRows){
    const live=liveKpi(r); if(!live) continue;
    const tr=document.querySelector(`tr[data-open-rx="${r.id}"]`); if(!tr) continue;
    tr.style.background = `linear-gradient(to right, ${KPI_FILL_COLOURS[live.colour]} ${live.pct}%, transparent ${live.pct}%)`;
    const cell=tr.querySelector('.elapsed-cell'); if(cell) cell.textContent = formatDuration(live.elapsedMin);
  }
  updateOverTargetTile();
}
$('refresh-btn').addEventListener('click',loadQueue); $('dispensary-filter').addEventListener('change',loadQueue);

// Warns (non-blocking) if the hospital number just typed already has a
// recent order - catches accidental duplicate entry while still allowing
// a genuine second order for the same patient today.
let hnCheckTimer=null;
async function checkDuplicateHospitalNumber(){
  const hn=$('book-hn').value.trim();
  const warnBox=$('book-hn-warning');
  if(hn.length<2){ warnBox.classList.add('hidden'); warnBox.innerHTML=''; return; }
  const since=new Date(Date.now()-24*60*60*1000).toISOString();
  const {data,error}=await sb.from('prescription_queue_view').select('display_id,stage_name,state,received_at').ilike('hospital_number',hn).gte('received_at',since).order('received_at',{ascending:false}).limit(5);
  if(error || !data || !data.length){ warnBox.classList.add('hidden'); warnBox.innerHTML=''; return; }
  const items=data.map(r=>`#${r.display_id} (${r.state==='cancelled'?'Cancelled':esc(r.stage_name)}, ${fmt(r.received_at)})`).join(', ');
  warnBox.innerHTML = `⚠ Recent order${data.length>1?'s':''} already booked for this hospital number in the last 24h: ${items}`;
  warnBox.classList.remove('hidden');
}
$('book-hn').addEventListener('input', ()=>{ clearTimeout(hnCheckTimer); hnCheckTimer=setTimeout(checkDuplicateHospitalNumber,500); });
$('book-hn').addEventListener('blur', checkDuplicateHospitalNumber);

$('book-form').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!can('perm_book_in')){ toast('You do not have permission to book prescriptions in',true); return; }
  if(!$('book-site').value){ toast('Please select a hospital/unit',true); return; }
  if(!$('book-ward').disabled && $('book-ward').options.length>1 && !$('book-ward').value){ toast('Please select a ward',true); return; }
  if(!$('book-type').value){ toast('Please select a prescription type',true); return; }
  const neededByVal = $('book-needed-by').value;
  const args={p_dispensary_id:$('book-dispensary').value,p_hospital_number:$('book-hn').value,p_prescription_type_id:$('book-type').value,p_site_id:$('book-site').value,p_patient_initials:$('book-initials').value||null,p_ward_id:$('book-ward').value||null,p_item_count:$('book-items').value?Number($('book-items').value):null,p_contains_cd:$('book-cd').checked,p_notes:$('book-notes').value||null,p_needed_by:neededByVal?new Date(neededByVal).toISOString():null};
  const {data,error}=await sb.rpc('book_in_prescription',args); if(error){toast(error.message,true);return;} e.target.reset(); fillSelects(); $('book-hn-warning').classList.add('hidden'); $('book-hn-warning').innerHTML=''; toast(`Prescription #${data.display_id} booked in`); await loadQueue(); document.querySelector('[data-view="dashboard"]').click();
});



function renderFacts(rx){
  const chips=[
    `${esc(rx.prescription_type_name||'—')}${rx.contains_cd?' · CD':''}`,
    rx.ward_name ? esc(rx.ward_name) : esc(rx.site_name||'—'),
    rx.item_count!=null ? `${rx.item_count} item${rx.item_count===1?'':'s'}` : null,
    rx.needed_by ? `Needed by ${fmt(rx.needed_by)}` : null,
  ].filter(Boolean);
  const overdue = rx.needed_by && rx.state==='active' && new Date(rx.needed_by) < new Date();
  $('rx-facts').innerHTML = `<div class="rx-hn-line"><strong>${esc(rx.hospital_number)}</strong>${rx.patient_initials?` · ${esc(rx.patient_initials)}`:''}${rx.state==='cancelled'?' <span class="state-pill">Cancelled</span>':''}</div>`+
    `<div class="rx-chips">${chips.map((c,i)=>`<span class="rx-chip${i===3&&overdue?' rx-chip-overdue':''}">${c}</span>`).join('')}</div>`+
    (rx.state==='cancelled' && rx.cancel_reason ? `<div class="muted tiny">Cancelled by ${esc(rx.cancelled_by_name||'—')} · ${fmt(rx.cancelled_at)} — ${esc(rx.cancel_reason)}</div>` : '');
}
function renderStepper(rx){
  const steps=[
    {label:'Booked in', done:true, by:rx.created_by_name, at:rx.received_at},
    {label:'Screened', done: rx.prescription_type_is_prescreened || !!rx.screened_by_name, by: rx.prescription_type_is_prescreened ? 'Pre-screened' : rx.screened_by_name, at: rx.screened_at, current: rx.stage_code==='awaiting_screening'},
    {label:'Dispensed', done: !!rx.dispensed_by_name, by: rx.dispensed_by_name, at: rx.dispensed_at, current: rx.stage_code==='awaiting_labelling', inProgressBy: rx.stage_code==='awaiting_labelling' ? rx.dispensing_started_by_name : null},
    {label:'Checked', done: !!rx.checked_by_name, by: rx.checked_by_name, at: rx.checked_at, current: rx.stage_code==='awaiting_final_check'},
  ];
  $('rx-stepper').innerHTML = steps.map(s=>{
    const cls=['rx-step']; if(s.done) cls.push('done'); if(s.current) cls.push('current'); if(rx.state==='suspended'&&s.current) cls.push('suspended'); if(rx.state==='cancelled') cls.push('cancelled');
    let caption='';
    if(s.done && s.by) caption=`${esc(s.by)}${s.at?` · ${fmt(s.at)}`:''}`;
    else if(s.inProgressBy) caption=`Being dispensed by ${esc(s.inProgressBy)}`;
    else if(s.current) caption='In progress';
    return `<div class="${cls.join(' ')}"><div class="rx-step-dot">${s.done?'✓':''}</div><div class="rx-step-label">${esc(s.label)}</div>${caption?`<div class="rx-step-caption">${caption}</div>`:''}</div>`;
  }).join('<div class="rx-step-line"></div>');
}
// The single primary action for wherever this prescription currently sits.
// Colour progresses stage-by-stage; the final action (marking Checked)
// swaps the play triangle for a checkmark and turns green.
function actionForStage(rx){
  if(rx.state!=='active') return null;
  if(rx.stage_code==='awaiting_labelling'){
    if(!rx.dispensing_started_by){
      if(!can('perm_progress_standard')) return null;
      return {kind:'start', label:'Start dispensing', icon:'play', color:'var(--act-dispense)'};
    }
    if(rx.dispensing_started_by!==state.profile.id){
      return {kind:'claimed', label:`Being dispensed by ${rx.dispensing_started_by_name||'someone else'}`};
    }
  }
  const idx=state.stages.findIndex(s=>s.id===rx.current_stage_id); const next=state.stages[idx+1];
  if(!next) return null;
  const allowed = next.requires_role ? can('perm_progress_pharmacist') : can('perm_progress_standard');
  if(!allowed) return null;
  const terminal = next.code==='ready';
  const colourByStage = {awaiting_screening:'var(--act-screen)', awaiting_labelling:'var(--act-final)', awaiting_final_check:'var(--act-final)'};
  const label = terminal ? 'Mark Checked' : (rx.stage_code==='awaiting_labelling' ? 'Send for checking' : `Move to ${next.name}`);
  return {kind:'advance', code:next.code, label, icon: terminal?'check':'play', color: terminal?'var(--act-checked)':(colourByStage[rx.stage_code]||'var(--act-screen)')};
}
async function openPrescription(id){
  const {data:rx,error}=await sb.from('prescription_queue_view').select('*').eq('id',id).single();
  if(error){toast(error.message,true);return;} state.currentRx=rx;
  $('rx-title').textContent=`Prescription #${rx.display_id}`; $('rx-subtitle').textContent=`${rx.site_name||'—'} · ${rx.dispensary_name}`;
  renderFacts(rx); renderStepper(rx);
  await renderActions(rx); await loadTimeline(id);
  $('correction-panel').classList.toggle('hidden',!can('perm_progress_pharmacist'));
  $('suspend-panel').classList.add('hidden'); $('cancel-panel').classList.add('hidden');
  $('rx-dialog').showModal();
}
async function renderActions(rx){
  const box=$('rx-actions'); box.innerHTML='';
  $('cancel-toggle-btn').classList.toggle('hidden', !(can('perm_suspend') && (rx.state==='active'||rx.state==='suspended')));
  if(rx.state==='suspended'){
    if(can('perm_resume')){ const b=document.createElement('button'); b.className='btn primary'; b.textContent='Resume'; b.onclick=(ev)=>{ev.stopPropagation();resume(rx.id);}; box.appendChild(b); }
    return;
  }
  if(rx.state==='ready' && can('perm_progress_standard')){
    const b=document.createElement('button');b.className='btn primary';b.textContent='Mark collected / dispatched';b.onclick=(ev)=>{ev.stopPropagation();collect(rx.id);};box.appendChild(b);
    return;
  }
  if(rx.state!=='active') return;
  const action=actionForStage(rx);
  if(action){
    if(action.kind==='claimed'){
      const span=document.createElement('span'); span.className='rx-claimed-note'; span.textContent=action.label; box.appendChild(span);
    } else {
      const btn=document.createElement('button');
      btn.type='button'; btn.className='rx-action-btn'; btn.title=action.label;
      btn.style.setProperty('--act-color', action.color);
      btn.innerHTML = action.icon==='check' ? '&#10003;' : '&#9654;';
      btn.onclick=async(ev)=>{
        ev.stopPropagation();
        if(action.kind==='start') await startDispensing(rx.id);
        else await advanceAction(rx.id, action.code, action.icon==='check', btn);
      };
      box.appendChild(btn);
    }
  }
  if(can('perm_suspend')){
    const s=document.createElement('button'); s.type='button'; s.className='icon-btn-lg'; s.title='Suspend';
    s.innerHTML='&#10074;&#10074;';
    s.onclick=(ev)=>{ ev.stopPropagation(); $('suspend-panel').classList.toggle('hidden'); syncSuspendOtherRequirement(); };
    box.appendChild(s);
  }
}
async function startDispensing(id){
  const {error}=await sb.rpc('start_dispensing',{p_prescription_id:id});
  if(error){toast(error.message,true);return;} toast('Dispensing started — claimed by you'); await refreshOpen(id);
}
async function advanceAction(id, code, isFinal, btn){
  const {error}=await sb.rpc('advance_prescription',{p_prescription_id:id,p_to_stage_code:code});
  if(error){toast(error.message,true);return;}
  if(isFinal){
    if(btn) btn.classList.add('flash-success');
    toast('Prescription Checked — moved to History');
    await new Promise(r=>setTimeout(r,350));
    $('rx-dialog').close(); await loadQueue();
  } else {
    toast('Workflow updated'); await refreshOpen(id);
  }
}
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
$('cancel-toggle-btn').addEventListener('click', ()=>$('cancel-panel').classList.toggle('hidden'));
$('cancel-confirm-btn').addEventListener('click', async()=>{
  if(!state.currentRx)return;
  const reason=$('cancel-reason').value.trim();
  if(reason.length<3){ toast('Please give a reason to cancel this prescription',true); return; }
  const {error}=await sb.rpc('cancel_prescription',{p_prescription_id:state.currentRx.id,p_reason:reason});
  if(error){toast(error.message,true);return;}
  $('cancel-reason').value=''; $('cancel-panel').classList.add('hidden');
  toast('Prescription cancelled'); $('rx-dialog').close(); await loadQueue();
});
async function refreshOpen(id){ await loadQueue(); await openPrescriptionDataOnly(id); }
async function openPrescriptionDataOnly(id){
  const {data}=await sb.from('prescription_queue_view').select('*').eq('id',id).single();
  if(!data){$('rx-dialog').close();return;}
  state.currentRx=data; $('rx-title').textContent=`Prescription #${data.display_id}`;
  renderFacts(data); renderStepper(data);
  await renderActions(data); await loadTimeline(id);
}

function eventDetailText(e){
  const d = e.details || {};
  switch(e.event_type){
    case 'BOOKED_IN': return d.needed_by ? `Needed by ${fmt(d.needed_by)}` : '';
    case 'SUSPENDED': return [d.reason_name, d.note].filter(Boolean).join(' — ');
    case 'HOSPITAL_NUMBER_CORRECTED': return `${d.old||''} → ${d.new||''}${d.reason?` — ${d.reason}`:''}`;
    case 'CANCELLED': return d.reason || '';
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
function eventLabel(e){ return ({BOOKED_IN:'Booked in',STAGE_ADVANCED:`Moved to ${e.to_stage?.name||'next stage'}`,DISPENSING_STARTED:'Dispensing started',SUSPENDED:'Suspended',RESUMED:'Resumed',COLLECTED:'Collected / dispatched',HOSPITAL_NUMBER_CORRECTED:'Hospital number corrected',CANCELLED:'Cancelled'})[e.event_type]||e.event_type.replaceAll('_',' '); }
$('rx-close').addEventListener('click',()=>$('rx-dialog').close());

$('history-btn').addEventListener('click',searchHistory); $('history-search').addEventListener('keydown',e=>{if(e.key==='Enter')searchHistory()});
async function searchHistory(){
  let q=sb.from('prescription_queue_view').select('*').order('received_at',{ascending:false}).limit(200); const term=$('history-search').value.trim(); const st=$('history-state').value;
  if(st) q=q.eq('state',st); if(term){ if(/^#?\d+$/.test(term)&&term.replace('#','').length<10) q=q.eq('display_id',Number(term.replace('#',''))); else q=q.ilike('hospital_number',`%${term.replace(/[%_,]/g,'')}%`); }
  const {data,error}=await q; if(error){toast(error.message,true);return;}
  $('history-body').innerHTML=(data||[]).map(r=>`<tr class="row-clickable" data-open-rx="${r.id}"><td data-label="ID">#${r.display_id}</td><td data-label="Hospital no.">${esc(r.hospital_number)}</td><td data-label="Ward">${esc(r.ward_name||'—')}</td><td data-label="State"><span class="state-pill">${esc(r.state)}</span></td><td data-label="Stage">${esc(r.stage_name)}</td><td data-label="Received">${fmt(r.received_at)}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No results.</td></tr>';
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
    const roleLabel = u.is_superuser ? 'Superuser' : (ROLE_LABELS[u.role]||u.role);
    let actions='';
    if(u.id!==state.profile.id && !u.is_superuser){
      actions = `<div class="filters">
        <button class="btn ghost" data-manage-user="${u.id}">Manage</button>
        <button class="btn ${u.active?'danger':'secondary'}" data-toggle-active="${u.id}">${u.active?'Suspend':'Reactivate'}</button>
        <button class="btn ghost" data-reset-password="${u.id}">Reset password</button>
      </div>`;
    }
    return `<tr><td>${esc(u.username)}</td><td>${esc(u.display_name)}</td><td>${esc(roleLabel)}</td><td>${esc(u.gphc_number||'—')}</td><td>${u.active?'Yes':'No'}</td><td><div class="perm-badges">${badges}</div></td><td>${actions}</td></tr>`;
  }).join('');
  document.querySelectorAll('[data-manage-user]').forEach(b=>b.addEventListener('click',()=>openManageUser(b.dataset.manageUser)));
  document.querySelectorAll('[data-toggle-active]').forEach(b=>b.addEventListener('click',()=>quickToggleActive(b.dataset.toggleActive)));
  document.querySelectorAll('[data-reset-password]').forEach(b=>b.addEventListener('click',()=>quickResetPassword(b.dataset.resetPassword)));
}
function generateTempPassword(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr=new Uint32Array(14); crypto.getRandomValues(arr);
  let out=''; for(let i=0;i<14;i++) out+=chars[arr[i]%chars.length];
  return out;
}
async function quickToggleActive(id){
  const u=state.users.find(x=>x.id===id); if(!u) return;
  const nextActive=!u.active;
  const {data,error}=await sb.functions.invoke('manage-user',{body:{user_id:id, active:nextActive}});
  if(error||data?.error){ toast(data?.error||error.message,true); return; }
  toast(`${u.display_name} ${nextActive?'reactivated':'suspended'}`); await loadUsers();
}
async function quickResetPassword(id){
  const u=state.users.find(x=>x.id===id); if(!u) return;
  const pwd=generateTempPassword();
  const {data,error}=await sb.functions.invoke('manage-user',{body:{user_id:id, password:pwd}});
  if(error||data?.error){ toast(data?.error||error.message,true); return; }
  window.prompt(`Temporary password for ${u.username} — copy it now and share it with them (it won't be shown again):`, pwd);
  toast('Password reset');
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

/* ---------- Configuration: dispensary / site / ward manual add ---------- */
$('disp-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('dispensaries').insert({name:$('disp-name').value.trim(),created_by:state.profile.id});if(error){toast(error.message,true);return;}e.target.reset();toast('Dispensary added — tick which hospitals it serves below');await loadReference();});
$('site-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('sites').insert({name:$('site-name').value.trim(),created_by:state.profile.id});if(error){toast(error.message,true);return;}e.target.reset();toast('Site added');await loadReference();await loadRP();});
$('ward-form').addEventListener('submit',async e=>{e.preventDefault();const {error}=await sb.from('wards').insert({site_id:$('ward-site').value,name:$('ward-name').value.trim()});if(error){toast(error.message,true);return;}e.target.reset();toast('Ward/location added');await loadReference();});

/* ---------- Configuration: dispensary <-> site coverage matrix ---------- */
function renderDispensarySites(){
  const head=$('disp-sites-table').querySelector('thead tr');
  const wardCount=(siteId)=>state.wards.filter(w=>w.site_id===siteId).length;
  head.innerHTML = '<th>Dispensary</th>' + state.sites.map(s=>`<th>${esc(s.name)}<br><small class="muted tiny">${wardCount(s.id)} ward${wardCount(s.id)===1?'':'s'}</small></th>`).join('');
  if(!state.dispensaries.length){ $('disp-sites-body').innerHTML=`<tr><td colspan="${1+state.sites.length}" class="muted">Add a dispensary above first.</td></tr>`; return; }
  if(!state.sites.length){ $('disp-sites-body').innerHTML=`<tr><td class="muted">Add a hospital site above to link it here.</td></tr>`; return; }
  $('disp-sites-body').innerHTML = state.dispensaries.map(d=>{
    const cells = state.sites.map(s=>{
      const checked = state.dispensarySites.some(ds=>ds.dispensary_id===d.id && ds.site_id===s.id);
      return `<td style="text-align:center"><input type="checkbox" data-disp="${d.id}" data-site="${s.id}" ${checked?'checked':''}></td>`;
    }).join('');
    return `<tr><td>${esc(d.name)}</td>${cells}</tr>`;
  }).join('');
  $('disp-sites-body').querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.addEventListener('change', async()=>{
    const dispId=cb.dataset.disp, siteId=cb.dataset.site;
    if(cb.checked){
      const {error}=await sb.from('dispensary_sites').insert({dispensary_id:dispId,site_id:siteId});
      if(error){ toast(error.message,true); cb.checked=false; return; }
      state.dispensarySites.push({dispensary_id:dispId,site_id:siteId});
    } else {
      const {error}=await sb.from('dispensary_sites').delete().eq('dispensary_id',dispId).eq('site_id',siteId);
      if(error){ toast(error.message,true); cb.checked=true; return; }
      state.dispensarySites = state.dispensarySites.filter(ds=>!(ds.dispensary_id===dispId && ds.site_id===siteId));
    }
    fillSelects();
  }));
}

/* ---------- Configuration: prescription types (dynamic, per-type KPI, prescreened routing) ---------- */
function renderPrescriptionTypes(){
  $('ptype-body').innerHTML = state.prescriptionTypes.map(t=>{
    const a=hm(t.amber_minutes), r=hm(t.red_minutes);
    return `<tr data-ptype="${t.id}">
      <td>${esc(t.name)}</td>
      <td style="text-align:center"><input type="checkbox" class="pt-prescreened" ${t.is_prescreened?'checked':''}></td>
      <td class="filters"><input type="number" min="0" class="pt-amber-h" value="${a.h}" style="width:56px">h <input type="number" min="0" max="59" class="pt-amber-m" value="${a.m}" style="width:56px">m</td>
      <td class="filters"><input type="number" min="0" class="pt-red-h" value="${r.h}" style="width:56px">h <input type="number" min="0" max="59" class="pt-red-m" value="${r.m}" style="width:56px">m</td>
      <td>${t.is_default?'<span class="perm-badge super">Default</span>':`<button class="btn ghost" data-set-default-ptype="${t.id}">Make default</button>`}</td>
      <td class="filters"><button class="btn secondary" data-save-ptype="${t.id}">Save</button><button class="btn ghost" data-deactivate-ptype="${t.id}">Deactivate</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">No prescription types yet — add one above.</td></tr>';
  document.querySelectorAll('[data-save-ptype]').forEach(b=>b.addEventListener('click',()=>savePrescriptionType(b.dataset.savePtype)));
  document.querySelectorAll('[data-deactivate-ptype]').forEach(b=>b.addEventListener('click',()=>deactivatePrescriptionType(b.dataset.deactivatePtype)));
  document.querySelectorAll('[data-set-default-ptype]').forEach(b=>b.addEventListener('click',()=>setDefaultPrescriptionType(b.dataset.setDefaultPtype)));
}
$('ptype-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const name=$('ptype-name').value.trim();
  const isPrescreened=$('ptype-prescreened').checked;
  const amber=(Number($('ptype-amber-h').value)||0)*60+(Number($('ptype-amber-m').value)||0);
  const red=(Number($('ptype-red-h').value)||0)*60+(Number($('ptype-red-m').value)||0);
  if(!name){ toast('Name required',true); return; }
  if(amber<=0||red<=0){ toast('Enter a turnaround time greater than zero for both amber and red',true); return; }
  if(red<=amber){ toast('Red must be a longer turnaround than amber',true); return; }
  let code=slugify(name);
  let {error}=await sb.from('prescription_types').insert({code, name, is_prescreened:isPrescreened, amber_minutes:amber, red_minutes:red, created_by:state.profile.id});
  if(error && /duplicate key/i.test(error.message)){
    code = `${code}_${Math.floor(Math.random()*900+100)}`;
    ({error}=await sb.from('prescription_types').insert({code, name, is_prescreened:isPrescreened, amber_minutes:amber, red_minutes:red, created_by:state.profile.id}));
  }
  if(error){ toast(error.message,true); return; }
  e.target.reset(); toast(`Prescription type "${name}" added`); await loadReference();
});
async function savePrescriptionType(id){
  const row=document.querySelector(`tr[data-ptype="${id}"]`);
  const isPrescreened=row.querySelector('.pt-prescreened').checked;
  const ah=Number(row.querySelector('.pt-amber-h').value)||0, am=Number(row.querySelector('.pt-amber-m').value)||0;
  const rh=Number(row.querySelector('.pt-red-h').value)||0, rm=Number(row.querySelector('.pt-red-m').value)||0;
  const amber=ah*60+am, red=rh*60+rm;
  if(amber<=0||red<=0){ toast('Enter a turnaround time greater than zero for both amber and red',true); return; }
  if(red<=amber){ toast('Red must be a longer turnaround than amber',true); return; }
  const {error}=await sb.from('prescription_types').update({is_prescreened:isPrescreened, amber_minutes:amber, red_minutes:red}).eq('id',id);
  if(error){ toast(error.message,true); return; }
  toast('Prescription type saved'); await loadReference(); await loadQueue();
}
async function deactivatePrescriptionType(id){
  const t=state.prescriptionTypes.find(x=>x.id===id);
  const {error}=await sb.from('prescription_types').update({active:false}).eq('id',id);
  if(error){ toast(error.message,true); return; }
  toast(`${t?.name||'Type'} deactivated${t?.is_default?' — pick a new default':''}`); await loadReference();
}
async function setDefaultPrescriptionType(id){
  await sb.from('prescription_types').update({is_default:false}).eq('is_default',true);
  const {error}=await sb.from('prescription_types').update({is_default:true}).eq('id',id);
  if(error){ toast(error.message,true); return; }
  toast('Default prescription type updated'); await loadReference();
}

/* ---------- Configuration: suspension reasons (dynamic; "Other" is the only fixed one) ---------- */
function renderSuspensionReasons(){
  $('reason-body').innerHTML = state.suspensionReasons.map(r=>{
    const isOther = r.name.trim().toLowerCase()==='other';
    return `<tr><td>${esc(r.name)}</td><td>${isOther?'<span class="muted tiny">Fixed — enables the free-text box</span>':`<button class="btn ghost" data-deactivate-reason="${r.id}">Deactivate</button>`}</td></tr>`;
  }).join('') || '<tr><td colspan="2" class="muted">No suspension reasons yet.</td></tr>';
  document.querySelectorAll('[data-deactivate-reason]').forEach(b=>b.addEventListener('click',()=>deactivateSuspensionReason(b.dataset.deactivateReason)));
}
$('reason-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const name=$('reason-name').value.trim(); if(!name) return;
  const {error}=await sb.from('suspension_reasons').insert({name});
  if(error){ toast(error.message,true); return; }
  e.target.reset(); toast(`Suspension reason "${name}" added`); await loadReference();
});
async function deactivateSuspensionReason(id){
  const r=state.suspensionReasons.find(x=>x.id===id);
  if(r && r.name.trim().toLowerCase()==='other'){ toast('"Other" can\'t be removed — it powers the free-text box',true); return; }
  const {error}=await sb.from('suspension_reasons').update({active:false}).eq('id',id);
  if(error){ toast(error.message,true); return; }
  toast(`${r?.name||'Reason'} deactivated`); await loadReference();
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
