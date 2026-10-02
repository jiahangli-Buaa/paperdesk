'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
 settings:'<circle cx="12" cy="12" r="3"/><path d="m9.5 3-.6 2.3-2 1.2-2.3-.6-2.5 4.2 1.7 1.7v2.4l-1.7 1.7 2.5 4.2 2.3-.6 2 1.2.6 2.3h5l.6-2.3 2-1.2 2.3.6 2.5-4.2-1.7-1.7v-2.4l1.7-1.7-2.5-4.2-2.3.6-2-1.2-.6-2.3z"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 book:'<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM13 7a3 3 0 0 1 3-3h4v15h-3a4 4 0 0 0-4 2"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 refresh:'<path d="M20 8a8 8 0 0 0-13-3L3 8m0-5v5h5M4 16a8 8 0 0 0 13 3l4-3m0 5v-5h-5"/>',
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
 file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
 edit:'<path d="m16 3 5 5L9 20l-6 1 1-6zM13 6l5 5"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
 eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
 external:'<path d="M14 3h7v7M21 3l-11 11M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 chevron:'<path d="m9 5 7 7-7 7"/>',
 laptop:'<rect x="4" y="3" width="16" height="13" rx="2"/><path d="M2 20h20M9 16l-1 4m7-4 1 4"/>',
 inbox:'<path d="M4 4h16l2 12v4H2v-4zM2 14h6l2 3h4l2-3h6"/>',
 users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2"/>',
 arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const statuses = {submitted:'已投稿',editor:'编辑处理中',review:'审稿中',decision:'等待决定',revision:'待返修',accepted:'已录用',rejected:'已拒稿',withdrawn:'已撤稿',unknown:'待确认'};
const closed = s => ['accepted','rejected','withdrawn'].includes(s);
const refreshable = s => !closed(s) && s !== 'revision';
const ssoName = account => account.login_method==='elsevier'?'Elsevier':'ORCID';
const isSsoAccount = account => ['orcid','elsevier'].includes(account.login_method);
const badge = (s,label) => `<span class="badge ${esc(s)}">${esc(label || statuses[s] || s)}</span>`;
const dateText = value => value ? String(value).slice(0,10).replaceAll('-', '.') : '未记录';
const submissionDate = p => p?.system_submitted_at ? dateText(p.system_submitted_at) : '待同步';
const shortDate = value => value ? String(value).slice(5,10).replace('-', '.') : '—';
const timeText = value => value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '尚未检查';
const safeUrl = url => { try { const u = new URL(url); return u.protocol === 'https:' ? esc(u.href) : '#'; } catch { return '#'; } };
const nameKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s.\-]+/g,'');
const includesMe = value => {
 const names=[live.profile?.name,...(live.profile?.aliases||[])].filter(Boolean).map(nameKey);
 return String(value||'').split(/[、,;；/|&\n]+/).some(name=>names.includes(nameKey(name)));
};
function matchesAuthorRole(paper, role) {
 const first = includesMe(paper.first_author), corresponding = includesMe(paper.corresponding_author);
 return !role || (role === 'mine' && (first || corresponding)) || (role === 'first' && first) || (role === 'corresponding' && corresponding);
}

let live = {journals:[],accounts:[],manuscripts:[],events:[]};
const preferenceKey = 'paperdesk-list-preferences-v1';
function readPreferences() { try { return JSON.parse(localStorage.getItem(preferenceKey)||'{}')||{}; } catch { return {}; } }
const savedPreferences = readPreferences();
let view = 'overview', tab = ['active','all','closed'].includes(savedPreferences.tab)?savedPreferences.tab:'active';
let search = typeof savedPreferences.search==='string'?savedPreferences.search:'', journalFilter = savedPreferences.journalFilter||'';
let authorFilter = ['','mine','first','corresponding'].includes(savedPreferences.authorFilter)?savedPreferences.authorFilter:'';
let sort = savedPreferences.sort==='priority'?'priority':'submission', onlyUnread = false;
function savePreferences() { try { localStorage.setItem(preferenceKey,JSON.stringify({tab,search,journalFilter,authorFilter,sort})); } catch {} }
let toastTimer, metricsPollTimer, refreshing = false, connectingAccount = '';
const current = () => live;
function journalMetrics(journal) {
 const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');
 const record = (live.journal_metrics || []).find(item =>
  item.names.some(name => normalize(name) === normalize(journal.name)) ||
  (journal.login_url && item.login_urls.includes(journal.login_url.replace(/\/$/, ''))));
 const cas = record?.cas, impact = record?.impact_factor;
 const check = live.journal_metric_sync?.[journal.id] || {};
 const missing = label => `<span class="journal-metric pending" title="${esc(check.error||'')}">${label} · ${check.pending?'正在查询':check.error?'暂未查到':'待核实'}</span>`;
 const casBadge = cas
  ? `<a class="journal-metric cas" href="${safeUrl(cas.source_url)}" target="_blank" rel="noopener noreferrer" title="${esc(`${cas.edition} · 大类：${cas.category} · 来源：${cas.source_name} · 核对日期：${record.checked_at}`)}">中科院 ${cas.zone} 区${cas.top?' TOP':''}<span>${cas.year}</span></a>`
  : missing('中科院分区');
 const impactBadge = impact
  ? `<a class="journal-metric impact" href="${safeUrl(impact.source_url)}" target="_blank" rel="noopener noreferrer" title="${esc(`${impact.year} 年影响因子 · 来源：${impact.source_name} · 核对日期：${record.checked_at}`)}">IF ${esc(impact.value)}<span>${impact.year}</span></a>`
  : missing('IF');
 return `<div class="journal-metrics" aria-label="期刊分区与影响因子">${casBadge}${impactBadge}</div>`;
}
const rows = () => current().manuscripts.map(p => {
 const account = current().accounts.find(a => a.id === p.account_id) || {};
 const journal = current().journals.find(j => j.id === account.journal_id) || {};
 return {...p,account,journal};
});
const labelSource = s => s === 'manual' ? '手动记录' : '网站读取';
const btn = (action,text,type='',id='') => `<button class="btn ${type}" data-action="${action}" ${id ? `data-id="${esc(id)}"` : ''}>${text}</button>`;

function toast(message) {
 $('#toast').textContent = message; $('#toast').classList.add('show');
 clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'),5500);
}
async function api(path, data, token=live.token) {
 const response = await fetch(path, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Paperdesk-Token':token},body:JSON.stringify(data)});
 const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作未完成'); return result;
}
async function load() {
 live = await api('/api/state');
 if(journalFilter&&!live.journals.some(j=>j.id===journalFilter)){journalFilter='';savePreferences();}
 deliverDesktop(live);
 clearTimeout(metricsPollTimer);
 if(Object.values(live.journal_metric_sync||{}).some(check=>check.pending)) {
  metricsPollTimer=setTimeout(async()=>{
   try { await load(); if(!$('#modal').open)render(); } catch {}
  },2000);
 }
}
async function runRefresh(payload={}) {
 if(refreshing)return;
 refreshing=true;render();toast(payload.interactive?'正在打开验证窗口，请完成网站验证…':'正在后台读取审稿中稿件的投稿状态…');
 try { const result=await api('/api/refresh',payload);await load();toast(result.message); }
 catch(err) { toast(err.message); }
 finally { refreshing=false;render(); }
}
async function connectSso(id,interactive=false) {
 if(refreshing)return;
 refreshing=true;connectingAccount=id;render();toast(interactive?'正在打开验证窗口…':'正在后台检查账号登录…');
 try { const result=await api('/api/accounts/connect',{account_id:id,interactive});await load();toast(result.message); }
 catch(err) { await load();toast(err.message); }
 finally { refreshing=false;connectingAccount='';render(); }
}
function accountReadText(account) {
 if(connectingAccount===account.id)return '正在检查 ORCID 登录…';
 if(account.sync_error)return account.sync_error;
 if(isSsoAccount(account)){const provider=ssoName(account);return account.last_checked_at ? provider+' · 最近读取：'+timeText(account.last_checked_at) : account.last_authenticated_at ? provider+' 已连接 · 添加稿件后后台读取' : account.has_password ? provider+' 密码已由系统保护保存 · 添加稿件后后台读取' : '尚未保存 '+provider+' 密码';}
 if(!account.has_password)return '尚未保存密码';
 if(!account.auto_read_supported)return '密码已由系统保护保存 · 此期刊待接入';
 return account.last_checked_at ? '最近读取：'+timeText(account.last_checked_at) : '密码已由系统保护保存 · 添加稿件后自动读取';
}
function eventsFor(id) { return current().events.filter(e => !id || e.manuscript_id === id).reverse().sort((a,b) => b.happened_at.localeCompare(a.happened_at)); }
function dueDays(p) { return p.due_days ?? null; }
function dueLabel(p) { const n=dueDays(p);return n===null ? '截止日期未记录' : n<0 ? `已过期 ${-n} 天` : n===0 ? '今天截止' : `剩余 ${n} 天`; }
const unreadPapers = () => rows().filter(p=>p.unread_changes?.length);
const statusDaysLabel = p => p.status_days===null||p.status_days===undefined?'':`当前状态持续 ${p.status_days} 天`;
const submissionDaysLabel = p => p.submitted_days===null||p.submitted_days===undefined?'':`投稿至今 ${p.submitted_days} 天`;
const transitionLabel = change => `${change.old_label||'已投稿'} → ${change.new_label}`;
function changeHTML(p) {
 const change=p.unread_changes?.[0];
 if(!change)return '';
 const same=change.old_label===change.new_label;
 return `<button class="change-hint" data-action="detail" data-id="${esc(p.id)}"><span class="unread-dot" aria-hidden="true"></span><span>${same?'网站状态有更新':esc(transitionLabel(change))}${p.unread_changes.length>1?` · ${p.unread_changes.length} 次变化`:''}</span></button>${same?`<div class="change-raw">${esc(change.old_raw)} → ${esc(change.new_raw)}</div>`:''}`;
}
function deadlineSummary() {
 if(!live.notification_settings?.deadline_reminders)return '';
 const due=rows().filter(p=>p.status==='revision'&&p.due_days!==null&&p.due_days<=7).sort((a,b)=>a.due_days-b.due_days);
 if(!due.length)return '';
 return `<div class="deadline-summary">${icon('clock')}<span><b>${due.length} 篇返修临近或已到截止日期</b> · 最近一篇${dueLabel(due[0])}</span>${btn('detail','查看稿件','text',due[0].id)}</div>`;
}
function reminderHTML(p) {
 if(p.status!=='revision'||!p.due_date)return '';
 const urgent=dueDays(p)<=3;
 return `<div class="deadline-hint ${urgent?'urgent':''}">${p.deadline_alerts?.length?'<span class="unread-dot" title="新的返修截止提醒"></span>':icon('clock')}返修${dueLabel(p)}</div>`;
}
async function markRead(ids) {
 if(!ids.length)return;
 await api('/api/notifications/read',{ids});
 const read=new Set(ids);
 live.notifications=(live.notifications||[]).filter(n=>!read.has(n.id));
 for(const paper of live.manuscripts)for(const key of ['unread_changes','deadline_alerts'])paper[key]=(paper[key]||[]).filter(n=>!read.has(n.id));
 for(const event of live.events)if(read.has('event:'+event.id))event.unread=false;
 if(!unreadPapers().length)onlyUnread=false;
 render();
}
function desktopPermissionText() {
 if(window.paperdesk)return '由 Paperdesk 发送系统通知';
 if(!('Notification' in window))return '此浏览器暂不支持桌面通知，站内提醒照常显示。';
 return Notification.permission==='granted'?'桌面通知已允许':Notification.permission==='denied'?'桌面通知已被浏览器关闭，可在网站权限中开启。':'启用桌面通知时，浏览器会请求通知权限。';
}
let desktopDelivering=false;
async function deliverDesktop(data) {
 if(window.paperdesk)return;
 if(desktopDelivering||!('Notification' in window)||Notification.permission!=='granted')return;
 const prefs=data.notification_settings||{};
 const candidates=(data.notifications||[]).filter(n=>!n.desktop_at&&prefs[n.kind==='status'?'status_desktop':'deadline_desktop']);
 if(!candidates.length)return;
 desktopDelivering=true;
 try {
  const claimed=await api('/api/notifications/claim',{ids:candidates.map(n=>n.id)},data.token);
  const notices=candidates.filter(n=>claimed.ids.includes(n.id));
  if(!notices.length)return;
  const notice=notices[0],p=data.manuscripts.find(p=>p.id===notice.manuscript_id);
  const body=notices.length===1?`${p?.title_en||p?.title||''}\n${notice.kind==='status'?transitionLabel(notice):'返修'+dueLabel(p)}`:`${notices.filter(n=>n.kind==='status').length} 条状态变化，${notices.filter(n=>n.kind==='deadline').length} 条返修提醒。打开看板查看。`;
  const notification=new Notification('Paperdesk · '+(notices.length===1?(notice.kind==='status'?'投稿状态有变化':'返修截止提醒'):notices.length+' 条新提醒'),{body,tag:'paperdesk-'+notices.map(n=>n.id).join('-')});
  notification.onclick=async()=>{
   window.focus();notification.close();
   if($('#modal').open){toast('有新的投稿提醒，保存当前编辑后即可查看');return;}
   try {await load();$('#drawer').close();view=notices.length===1?'overview':'history';render();if(notices.length===1)detail(notice.manuscript_id);}
   catch {toast('请刷新看板查看最新提醒');}
  };
 } catch { /* Unread reminders remain visible in the dashboard. */ }
 finally {desktopDelivering=false;}
}
function lastCheckText() {
 const stamp=current().last_checked_at;
 return stamp ? `${dateText(stamp)} ${new Date(stamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}` : '尚未检查';
}

function scheduleTime(value) {
 return value ? new Intl.DateTimeFormat('zh-CN',{timeZone:live.profile?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)) : '未安排';
}
const backgroundRanges=[
 ['transparency','background-transparency','背景透明度',70],
 ['panel_transparency','panel-transparency','内容面板透明度',65],
 ['sidebar_transparency','sidebar-transparency','侧栏透明度',60]
];
function applyBackground(appearance=live.appearance) {
 const image=$('#background-image'),layer=$('#background-layer');
 const hasImage=Boolean(appearance?.image_url),transparency=appearance?.transparency??70;
 if(hasImage){if(image.getAttribute('src')!==appearance.image_url)image.src=appearance.image_url;}
 else image.removeAttribute('src');
 layer.style.opacity=String(1-transparency/100);
 document.body.style.setProperty('--panel-alpha',String(1-(appearance?.panel_transparency??65)/100));
 document.body.style.setProperty('--sidebar-alpha',String(1-(appearance?.sidebar_transparency??60)/100));
 document.body.classList.toggle('has-background',hasImage);
}
function backgroundSettingsHTML() {
 const a=live.appearance||{},isDefault=backgroundRanges.every(([key,,,value])=>(a[key]??value)===value);
 const sliders=backgroundRanges.map(([key,id,label,fallback])=>{const value=a[key]??fallback;return `<div class="background-range"><label class="background-range-label" for="${id}">${label} <output id="${id}-value">${value}%</output></label><input type="range" id="${id}" data-appearance-key="${key}" min="0" max="100" step="1" value="${value}" aria-valuetext="${value}%"></div>`;}).join('');
 return `<h3 class="settings-section-title">自定义背景</h3><div class="background-settings"><div class="background-preview" id="background-preview">${a.image_url?`<img src="${esc(a.image_url)}" alt="当前背景图片">`:'<span>选择一张喜欢的图片</span>'}</div><div class="background-controls"><div class="background-actions"><label class="btn small file-button" for="background-upload">选择图片<input type="file" id="background-upload" accept="image/jpeg,image/png,image/webp,image/gif"></label><button type="button" class="btn small" data-action="background-reset" ${a.has_image||!isDefault?'':'disabled'}>恢复默认</button></div><p id="background-name" class="background-name">${esc(a.image_name||'尚未设置背景图片')}</p>${sliders}<p class="background-help">数值越高，对应图层越透明。调整后自动保存。<br>支持 JPG、PNG、WebP、GIF。大图自动优化，动画保持原样。</p></div></div>`;
}
function updateBackgroundControls() {
 const a=live.appearance;
 if(!$('#background-preview'))return;
 $('#background-preview').innerHTML=a.image_url?`<img src="${esc(a.image_url)}" alt="当前背景图片">`:'<span>选择一张喜欢的图片</span>';
 $('#background-name').textContent=a.image_name||'尚未设置背景图片';
 for(const [key,id,,fallback] of backgroundRanges){const value=a[key]??fallback;
  $('#'+id).value=value;
  $('#'+id).setAttribute('aria-valuetext',value+'%');
  $('#'+id+'-value').textContent=value+'%';
 }
 $('[data-action="background-reset"]').disabled=!a.has_image&&backgroundRanges.every(([key,,,value])=>(a[key]??value)===value);
}
async function prepareBackgroundImage(file) {
 const source=URL.createObjectURL(file);
 try {
  const image=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('图片无法打开，请选择 JPG、PNG、WebP 或 GIF 图片'));image.src=source;});
  const header=new Uint8Array(await file.slice(0,32).arrayBuffer());
  const signature=(from,to)=>String.fromCharCode(...header.slice(from,to));
  const animated=signature(0,3)==='GIF'||(signature(0,4)==='RIFF'&&signature(8,12)==='WEBP'&&signature(12,16)==='VP8X'&&(header[20]&2));
  if(animated)return file;
  const scale=Math.min(1,3840/Math.max(image.naturalWidth,image.naturalHeight));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
  canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const optimized=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.88));
  canvas.width=canvas.height=0;
  if(!optimized)throw new Error('图片未能处理，请重新选择');
  return scale===1&&optimized.size>=file.size?file:optimized;
 } finally {URL.revokeObjectURL(source);}
}
async function uploadBackground(file) {
 if(!file)return;
 const input=$('#background-upload');input.disabled=true;
 try {
  $('#background-name').textContent='正在优化图片…';
  const prepared=await prepareBackgroundImage(file);
  const response=await fetch('/api/background/image',{method:'POST',headers:{'X-Paperdesk-Token':live.token,'X-Paperdesk-Filename':encodeURIComponent(file.name),'Content-Type':prepared.type||'application/octet-stream'},body:prepared});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'图片未能保存');
  live.appearance=result.appearance;applyBackground();updateBackgroundControls();toast(result.message);
 }catch(err){updateBackgroundControls();toast(err.message);}
 finally{input.disabled=false;input.value='';}
}
async function saveBackground(body) {
 try {const result=await api('/api/background',body);live.appearance=result.appearance;applyBackground();updateBackgroundControls();if(body.reset)toast(result.message);}
 catch(err){applyBackground();updateBackgroundControls();toast(err.message);}
}
function scheduleForm() {
 const s=live.auto_refresh,n=live.notification_settings||{},supportsDesktop='Notification' in window;
 const last=s.last_finished_at?`${scheduleTime(s.last_finished_at)} · ${s.last_error||s.last_result.message||'刷新已完成'}`:'尚未执行首次定时刷新';
 modal('设置',`${backgroundSettingsHTML()}<h3 class="settings-section-title settings-divider">自动刷新</h3><label class="schedule-toggle"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}>启用每天自动刷新</label><div class="schedule-times">${s.times.map((t,i)=>field('time_'+i,'时间 '+(i+1),t,'','time',true)).join('')}</div><p class="form-intro">每天按 ${esc(live.profile?.timezone||'系统时区')} 刷新审稿中稿件。电脑联网且 Paperdesk 在后台运行时生效。</p><div class="form-notice">${icon('clock')}<span>下次：${esc(scheduleTime(s.next_run_at))}<br>上次：${esc(last)}</span></div><h3 class="settings-section-title settings-divider">提醒与通知</h3><label class="schedule-toggle"><input type="checkbox" name="deadline_reminders" ${n.deadline_reminders?'checked':''}>返修提醒（提前 7 天、3 天、1 天及截止当天）</label><label class="schedule-toggle"><input type="checkbox" name="status_desktop" ${n.status_desktop?'checked':''} ${supportsDesktop?'':'disabled'}>状态变化时发送桌面通知</label><label class="schedule-toggle"><input type="checkbox" name="deadline_desktop" ${n.deadline_desktop?'checked':''} ${supportsDesktop&&n.deadline_reminders?'':'disabled'}>返修临近截止时发送桌面通知</label><p class="form-intro">${desktopPermissionText()}<br>Paperdesk 在后台运行时也会通知；系统通知权限可在操作系统设置中管理。<br>排序和筛选会自动记住。</p>`,'schedule');
}

function render() {
 const data = current(), titles={overview:'投稿总览',accounts:'期刊账号',history:'状态记录'};
 const unreadCount=unreadPapers().length;
 const activeCount = data.manuscripts.filter(p => !closed(p.status)).length;
 const reading = refreshing || data.sync_in_progress;
 $('#app').innerHTML = `<div class="layout">
 <aside class="sidebar"><div class="brand"><div class="brand-name">Paperdesk</div><div class="brand-sub">投稿工作台</div></div>
 <nav aria-label="主导航"><div class="nav-label">工作空间</div>${[['overview','grid','投稿总览',activeCount],['accounts','book','期刊账号',data.journals.length],['history','clock','状态记录',unreadCount||'']].map(([key,i,t,n]) => `<button class="nav-item ${view===key?'active':''}" data-action="nav" data-id="${key}" ${view===key?'aria-current="page"':''}>${icon(i)}<span>${t}</span>${n!==''?`<span class="nav-count ${key==='history'&&unreadCount?'unread-count':''}">${n}</span>`:''}</button>`).join('')}</nav>
 <div class="sidebar-settings"><button class="nav-item" data-action="profile-settings">${icon('users')}<span>个人与数据</span></button><button class="nav-item" data-action="schedule-settings">${icon('settings')}<span>设置</span></button></div></aside>
 <main class="main">
 <div class="content"><div class="page-heading"><div><h1>${titles[view]}</h1>${view==='overview'?'':`<p>${view==='accounts'?'同一期刊可以关联多个账号，每个账号单独管理。':'按时间查看稿件的状态变化与记录来源。'}</p>`}</div><div class="actions">${view==='overview'?`<button class="btn" data-action="refresh" title="仅刷新审稿中稿件，待返修和已结束记录保留" ${reading?'disabled aria-busy="true"':''}>${icon('refresh')}${reading?'正在读取…':'刷新审稿中'}</button>`+btn('add-paper',icon('plus')+'添加稿件','primary'):view==='accounts'?btn('add-account',icon('plus')+'添加期刊账号','primary'):''}</div></div>
 ${view==='overview'?overview():view==='accounts'?accountsPage():historyPage()}
 <footer class="workspace-foot"><span>${icon('laptop')}数据保存在本机 · 密码由系统保护</span><span>按账号在后台读取投稿状态</span></footer></div></main></div>`;
 applyBackground();
}

function overview() {
 const p=rows(),active=p.filter(x=>!closed(x.status)),review=active.filter(x=>refreshable(x.status)),revision=p.filter(x=>x.status==='revision');
 const accepted=p.filter(x=>x.status==='accepted');
 const cards=[['在投稿件',active,'file',''],['审稿中',review,'eye','purple'],['待返修',revision,'edit','orange'],['已录用',accepted,'check','green']];
 return `<section class="stats" aria-label="投稿概览">${cards.map(([t,group,i,c])=>`<div class="stat"><div class="stat-top"><span>${t}</span><div class="stat-icon ${c}">${icon(i)}</div></div><div class="stat-num">${group.length.toString().padStart(2,'0')}</div><div class="stat-authors" aria-label="我的作者身份统计"><span>一作 <b>${group.filter(paper=>matchesAuthorRole(paper,'first')).length}</b></span><span>通讯 <b>${group.filter(paper=>matchesAuthorRole(paper,'corresponding')).length}</b></span></div></div>`).join('')}</section>
 <div class="work-grid"><section class="panel"><div class="panel-heading"><h2>我的稿件<span class="counter">共 ${p.length} 篇</span></h2><div class="list-heading-tools"><span class="refresh-summary">${icon('clock')}最近检查：<span id="last-checked-at">${lastCheckText()}</span></span><button class="btn text" data-action="sort">${sort==='priority'?'优先处理':'投稿时间 ↓'}</button></div></div>
 ${deadlineSummary()}${unreadPapers().length?`<div class="unread-summary"><button class="btn text ${onlyUnread?'selected':''}" data-action="unread-filter"><span class="unread-dot" aria-hidden="true"></span>${onlyUnread?'正在查看':'查看'} ${unreadPapers().length} 篇未读变化</button><button class="btn text muted" data-action="read-all">全部标为已读</button></div>`:''}<div class="tabs" role="tablist" aria-label="稿件范围">${[['active','进行中',active.length],['all','全部',p.length],['closed','已结束',p.length-active.length]].map(([v,t,n])=>`<button class="tab ${tab===v?'active':''}" role="tab" aria-selected="${tab===v}" data-action="tab" data-id="${v}">${t}<b>${n}</b></button>`).join('')}</div>
 <div class="filters"><label class="search">${icon('search')}<input id="search" aria-label="搜索稿件" placeholder="搜索标题或稿件编号" value="${esc(search)}"></label><select id="journal-filter" aria-label="按期刊筛选"><option value="">全部期刊</option>${current().journals.map(j=>`<option value="${esc(j.id)}" ${journalFilter===j.id?'selected':''}>${esc(j.abbreviation)}</option>`).join('')}</select><select id="author-filter" aria-label="按作者身份筛选">${[['','全部作者身份'],['mine','一作或通讯'],['first','第一作者'],['corresponding','通讯作者']].map(([value,label])=>`<option value="${value}" ${authorFilter===value?'selected':''}>${label}</option>`).join('')}</select></div>
 <div id="paper-results">${paperResults()}</div></section><aside class="rail">${todoPanel()}<section class="panel"><div class="panel-heading"><h2>最近变化</h2><button class="btn text" data-action="nav" data-id="history">全部${unreadPapers().length?` · ${unreadPapers().length} 篇未读`:''}</button></div>${eventsFor().length?`<div class="timeline">${eventsFor().slice(0,3).map(e=>eventHTML(e)).join('')}</div>`:'<p class="quiet">稿件状态有变化时，会记录在这里。</p>'}</section></aside></div>`;
}

function paperResults() {
 let p=rows().filter(x=>(!onlyUnread||x.unread_changes?.length)&&(tab==='all'||(tab==='active'?!closed(x.status):closed(x.status)))&&(!journalFilter||x.journal.id===journalFilter)&&matchesAuthorRole(x,authorFilter)&&(!search||`${x.title_en||''} ${x.title_zh||''} ${x.title} ${x.number||''}`.toLowerCase().includes(search.toLowerCase())));
 const priority={revision:0,decision:1,review:2,editor:3,submitted:4,unknown:5,accepted:6,rejected:7,withdrawn:8};
 p.sort((a,b)=>sort==='priority'?((priority[a.status]-priority[b.status])||(a.status==='revision'?((a.due_days??Infinity)-(b.due_days??Infinity)):0)||b.recorded_at.localeCompare(a.recorded_at)):(b.system_submitted_at||'').localeCompare(a.system_submitted_at||''));
 if(!p.length) return `<div class="empty"><div class="empty-icon">${icon('inbox')}</div><h3>${current().manuscripts.length?'没有符合条件的稿件':'你的投稿工作台，准备好了'}</h3><p>${current().manuscripts.length?'试试其他关键词，或调整期刊和作者身份筛选。':current().accounts.length?'选择投稿账号，填写自己的论文英文题目。看板只跟踪你主动添加的论文。':'先添加期刊账号，再填写你要跟踪的论文英文题目。'}</p><div class="actions">${current().manuscripts.length?btn('clear-filters','清除筛选','soft'):(current().accounts.length?btn('add-paper',icon('plus')+'添加我的论文','primary'):btn('add-account',icon('plus')+'添加期刊账号','primary'))}</div></div>`;
 return `<div class="table-wrap"><table class="papers"><thead><tr><th>期刊名称</th><th>论文题目</th><th>当前状态</th><th>第一作者</th><th>通讯作者</th><th title="以期刊系统记录为准">投稿日期</th></tr></thead><tbody>${p.map(x=>`<tr><td><div class="journal-full-name">${esc(x.journal.name)}</div>${journalMetrics(x.journal)}<div class="paper-meta mono">${esc(x.number||'稿件编号待识别')}</div></td><td><button class="paper-title manuscript-title" data-action="detail" data-id="${esc(x.id)}"><span class="paper-title-en ${x.title_en?'':'missing'}" lang="en" title="${esc(x.title_en||'待补充英文题目')}">${esc(x.title_en||'待补充英文题目')}</span></button>${changeHTML(x)}${reminderHTML(x)}</td><td>${badge(x.status,x.status_label)}${x.status_label==='拒稿重投'?'':`<div class="raw">${esc(x.raw_status)}</div>`}<div class="elapsed-days">${statusDaysLabel(x)}</div></td><td><span class="author-name ${x.first_author?'':'muted'}">${esc(x.first_author||'待补充')}</span></td><td><span class="author-name ${x.corresponding_author?'':'muted'}">${esc(x.corresponding_author||'待补充')}</span></td><td><span class="submission-date" title="以期刊系统记录为准">${submissionDate(x)}</span><div class="elapsed-days">${submissionDaysLabel(x)}</div></td></tr>`).join('')}</tbody></table></div><div class="table-footer"><span>显示 ${p.length} 篇稿件</span><span>点击题目查看完整标题与状态记录</span></div>`;
}

function todoPanel() {
 const pending=rows().filter(p=>p.status==='revision').sort((a,b)=>(a.due_days??Infinity)-(b.due_days??Infinity));
 const errors=live.accounts.filter(a=>a.sync_error&&live.manuscripts.some(p=>p.account_id===a.id&&refreshable(p.status)));
 return `<section class="panel"><div class="panel-heading"><h2>待处理<span class="count-pill">${pending.length+errors.length}</span></h2>${icon('clock')}</div><div class="todo">${pending.map(p=>`<div class="todo-item ${p.due_days!==null&&p.due_days<=3?'urgent':''}"><div class="todo-top">${esc(p.journal.abbreviation)} · ${p.status_label==='拒稿重投'?'拒稿重投':'返修'}<span>${dueLabel(p)}</span></div><div class="todo-title">${esc(p.title)}</div><p>截止 ${dateText(p.due_date)}</p>${btn('detail','查看稿件','text',p.id)}</div>`).join('')}${errors.length?errors.map(a=>`<div class="todo-item neutral"><div class="todo-title">${esc(live.journals.find(j=>j.id===a.journal_id)?.abbreviation)} · 读取需要处理</div><p>${esc(a.sync_error)}</p>${btn('nav','管理账号','text','accounts')}</div>`).join(''):!pending.length?'<p class="quiet">暂无待办。添加稿件后，这里会显示返修期限。</p>':''}</div></section>`;
}

function eventHTML(e, full=false) {
 const p=rows().find(p=>p.id===e.manuscript_id); if(!p) return '';
 return `<div class="event"><div class="event-dot ${e.unread?'unread':''}"></div><div class="event-content"><div><div class="event-title">${full?`<button class="paper-title" data-action="detail" data-id="${esc(p.id)}">${esc(p.title)}</button>`:`${esc(p.journal.abbreviation)} · ${esc(e.new_status_label || statuses[e.new_status])}`}</div><div class="event-copy">${full?`${esc(p.journal.abbreviation)} · ${esc(p.account.username)} · ${esc(p.number)}`:esc(p.title)}</div>${e.old_status&&e.old_raw_status&&e.old_raw_status!==e.raw_status?`<div class="event-transition">${esc(e.old_raw_status)} → ${esc(e.raw_status)}</div>`:''}<div class="event-time">${e.unread?'<span class="unread-text">未读 · </span>':''}${timeText(e.happened_at)} · ${labelSource(e.source)}</div></div>${full?`<div class="event-status">${e.old_status?badge(e.old_status,e.old_status_label)+icon('arrow'):''}${badge(e.new_status,e.new_status_label)}</div>`:''}</div></div>`;
}

function accountsPage() {
 return `<div class="journals-grid">${current().journals.map(j=>{
 const aa=current().accounts.filter(a=>a.journal_id===j.id), count=rows().filter(p=>p.journal.id===j.id).length;
 return `<section class="panel journal-card"><div class="journal-card-head"><div class="journal-monogram">${esc(j.abbreviation)}</div><div><h2>${esc(j.name)}</h2>${journalMetrics(j)}<p>${esc(j.platform)} · ${aa.length} 个账号 · ${count} 篇稿件</p></div>${j.login_url?`<a href="${safeUrl(j.login_url)}" target="_blank" rel="noopener noreferrer" class="icon-btn" aria-label="打开 ${esc(j.abbreviation)} 投稿网站">${icon('external')}</a>`:''}</div>
 ${aa.length?aa.map(a=>`<div class="journal-account"><div class="account-info"><h3>${esc(a.username)} <span class="muted">· ${current().manuscripts.filter(p=>p.account_id===a.id).length} 篇稿件</span></h3><div class="credential ${a.has_password?'':'absent'}">${icon(a.has_password?'lock':'info')}${esc(accountReadText(a))}</div>${isSsoAccount(a)?`<button class="btn small account-verification" data-action="connect-orcid" data-id="${esc(a.id)}" ${refreshing?'disabled':''}>${connectingAccount===a.id?'正在检查…':'检查登录'}</button>${/验证|授权|关联/.test(a.sync_error||'')?`<button class="btn small account-verification" data-action="verify-orcid" data-id="${esc(a.id)}" ${refreshing?'disabled':''}>打开验证窗口</button>`:''}`:/验证|登录未完成/.test(a.sync_error||'')?`<button class="btn small account-verification" data-action="verify-account" data-id="${esc(a.id)}" ${refreshing?'disabled':''}>打开验证窗口</button>`:''}</div><button class="btn small" data-action="edit-account" data-id="${esc(a.id)}">管理</button></div>`).join(''):'<p class="journal-empty">投稿入口已添加。可以在此期刊下添加多个投稿账号。</p>'}
 <button class="add-account" data-action="add-account" data-id="${esc(j.id)}">${icon('plus')}添加该期刊的账号</button></section>`;
 }).join('')}</div><p class="journal-explanation">${icon('users')}同一期刊的多个账号分开管理，只汇总你主动添加的论文。</p>`;
}
function historyPage() {
 return `<section class="panel"><div class="panel-heading"><h2>全部状态记录<span class="counter">${current().events.length} 条</span></h2><div class="actions">${unreadPapers().length?btn('read-all','全部标为已读','text'):''}<span class="muted">最新记录在前</span></div></div>${eventsFor().length?`<div class="history-list">${eventsFor().map(e=>eventHTML(e,true)).join('')}</div>`:'<div class="empty"><div class="empty-icon">'+icon('clock')+'</div><h3>还没有状态记录</h3><p>添加稿件或更新状态后，变化会自动记录在这里。</p></div>'}</section>`;
}

function detail(id) {
 const p=rows().find(x=>x.id===id); if(!p) return;
 $('#drawer').innerHTML=`<div class="modal-head"><h2>稿件详情</h2><button class="icon-btn" data-action="close-drawer" aria-label="关闭稿件详情">${icon('close')}</button></div><div class="drawer-body"><div class="drawer-kicker"><span class="journal-label">${esc(p.journal.abbreviation)}</span><span>${esc(p.round)}</span></div>${journalMetrics(p.journal)}<h2 class="drawer-title" lang="en">${esc(p.title_en||'待补充英文题目')}</h2><p class="drawer-title-zh">${esc(p.title_zh||'待补充中文题目')}</p>${badge(p.status,p.status_label)}<div class="raw">${esc(p.raw_status)}</div>${changeHTML(p)}${reminderHTML(p)}<dl class="drawer-fields">${[['稿件编号',p.number||'待识别'],['期刊',p.journal.name],['第一作者',p.first_author||'待补充'],['通讯作者',p.corresponding_author||'待补充'],['投稿账号',p.account.username],['投稿日期（期刊系统）',submissionDate(p)],['投稿天数',submissionDaysLabel(p)||'待同步'],['状态日期',dateText(p.status_date)],['状态天数',statusDaysLabel(p)||'待记录'],['返修截止',p.due_date?dateText(p.due_date)+' · '+dueLabel(p):'未记录'],['记录来源',labelSource(p.source)]].map(([a,b])=>`<div><dt>${a}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl><div class="actions">${p.journal.login_url?`<a class="btn" href="${safeUrl(p.journal.login_url)}" target="_blank" rel="noopener noreferrer">${icon('external')}打开投稿网站</a>`:''}${btn('edit-paper',icon('edit')+'编辑记录','primary',p.id)}</div><div class="drawer-section"><h3>状态时间线</h3><div class="timeline">${eventsFor(p.id).map(e=>eventHTML(e)).join('')||'<p class="quiet">尚无状态记录</p>'}</div></div>${p.notes?`<div class="drawer-section"><h3>备注</h3><p class="drawer-notes">${esc(p.notes)}</p></div>`:''}<p class="notice">未填写的网站状态日期显示为“未记录”。时间线标注保存或网站读取的时间。</p></div>`;
 if(!$('#drawer').open)$('#drawer').showModal();
 const ids=(live.notifications||[]).filter(n=>n.manuscript_id===id).map(n=>n.id);
 markRead(ids).catch(err=>toast(err.message));
}

const field=(name,label,value='',placeholder='',type='text',required=false)=>`<div class="field"><label for="f-${name}">${label}${required?' <em>*</em>':''}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required?'required':''} ${name==='username'?'autocomplete="username"':''}></div>`;
function modal(title,body,kind,id='') {
 $('#modal').innerHTML=`<form id="editor-form" data-kind="${kind}" data-id="${esc(id)}"><div class="modal-head"><h2>${title}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="关闭对话框">${icon('close')}</button></div><div class="form-body">${body}<p id="form-error" class="form-error hidden" role="alert"></p></div><div class="modal-foot"><button type="button" class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit">保存${kind==='schedule'?'设置':kind==='account'?'账号':'稿件'}</button></div></form>`;
 $('#modal').showModal();
}
function accountForm(id='',journalId='') {
 const a=id?live.accounts.find(x=>x.id===id):null;
 const j=a?live.journals.find(x=>x.id===a.journal_id):null;
 let selected=journalId;
 if(!selected&&live.journals.length===1) selected=live.journals[0].id;
 const journalFields=a?`<div class="form-notice">${icon('book')}<span>${esc(j.name)}<br>${esc(j.login_url)}</span></div>`:`<div class="field"><label for="f-journal_id">所属期刊 <em>*</em></label><select id="f-journal_id" name="journal_id">${live.journals.map(j=>`<option value="${esc(j.id)}" ${selected===j.id?'selected':''}>${esc(j.abbreviation)} · ${esc(j.name)}</option>`).join('')}<option value="" ${!selected?'selected':''}>新增期刊…</option></select></div><div id="new-journal-fields" class="field-section">${field('journal_name','期刊全名','','请输入期刊完整名称','text',true)}<div class="field-row">${field('abbreviation','期刊简称','','请输入期刊简称')}<div class="field"><label for="f-platform">投稿平台 <em>*</em></label><select id="f-platform" name="platform"><option>ScholarOne</option><option>Editorial Manager</option><option>PaperCept</option><option value="Open Journal Systems 3.4">OJS 3.4（试用）</option><option>其他</option></select></div></div>${field('login_url','投稿登录网址','','https://…','url',true)}</div>`;
 modal(a?'管理投稿账号':'添加期刊账号',`<p class="form-intro">同一期刊可添加多个 Elsevier、ORCID 或期刊账号，每个账号独立登录。</p>${journalFields}<div class="field"><label for="f-login_method">登录方式</label><select id="f-login_method" name="login_method"><option value="password">期刊账号密码</option><option value="orcid" ${a?.login_method==='orcid'?'selected':''}>ORCID 账号密码</option><option value="elsevier" ${a?.login_method==='elsevier'?'selected':''}>Elsevier 账号密码</option></select></div>${field('username','登录账号',a?.username||'','邮箱或 User ID','text',true)}<div id="password-field" class="field"><label for="f-password">密码</label><div class="password-wrap"><input id="f-password" name="password" type="password" autocomplete="new-password" placeholder="${a?.has_password?'留空保留已保存的密码':'可以先留空，之后补充'}" maxlength="4096"><button class="icon-btn" type="button" data-action="show-password" aria-label="显示密码">${icon('eye')}</button></div><small>密码保存在此电脑，由操作系统保护。</small></div><div id="orcid-notice" class="form-notice hidden">${icon('info')}<span>每个 ORCID 账号请分别添加，填写对应的邮箱或 iD 与密码。添加论文后会在后台自动登录，各账号的密码和登录会话分别保存。</span></div><div class="form-notice">${icon('info')}<span>填写期刊的实际投稿入口，系统会识别已接入的平台。新增期刊后自动查询中科院分区与 IF。</span></div>`,'account',a?.id||'');
 if(!a)updateAccountJournal();
 updateAccountAuth();
}
function updateAccountJournal() {
 const selected=$('#f-journal_id').value;
 const show=!selected;
 $('#new-journal-fields').classList.toggle('hidden',!show);
 $('#f-journal_name').required=show;$('#f-login_url').required=show;
 $('#f-login_method').value='password';
 updateAccountAuth();
}
function updateAccountAuth() {
 const method=$('#f-login_method').value,orcid=method==='orcid',elsevier=method==='elsevier';
 const provider=elsevier?'Elsevier':'ORCID';
 const editing=live.accounts.find(a=>a.id===$('#editor-form').dataset.id);
 const journal=live.journals.find(j=>j.id===($('#f-journal_id')?.value||editing?.journal_id));
 const papercept=$('#f-platform')?.value==='PaperCept' && !$('#new-journal-fields')?.classList.contains('hidden') || journal?.platform==='PaperCept';
 $('#password-field').classList.remove('hidden');$('#f-password').disabled=false;
 document.querySelector('label[for="f-password"]').textContent=orcid||elsevier?provider+' 密码':'密码';
 $('#orcid-notice').classList.toggle('hidden',!orcid&&!elsevier);
 $('#orcid-notice span').textContent=elsevier?'填写你在 Elsevier 登录页面使用的邮箱和密码。每个账号分别保存，添加论文后会自动登录并读取投稿状态。':'每个 ORCID 账号请分别添加，填写对应的邮箱或 iD 与密码。添加论文后会在后台自动登录，各账号的密码和登录会话分别保存。';
 $('#f-username').placeholder=elsevier?'Elsevier 登录邮箱':orcid?'ORCID 登录邮箱或 ORCID iD':papercept?'PaperCept PIN 或登录别名':'邮箱或 User ID';
 $('#f-username').type=elsevier?'email':'text';
 document.querySelector('label[for="f-username"]').innerHTML=(elsevier?'Elsevier 登录邮箱':orcid?'ORCID 账号（邮箱或 iD）':papercept?'PIN／登录别名':'登录账号')+' <em>*</em>';
}
function updateRevisionFields() {
 const section=$('#new-revision-fields');if(!section)return;
 const show=$('#f-status').value==='revision';section.classList.toggle('hidden',!show);
 section.querySelectorAll('input').forEach(input=>input.disabled=!show);
}

function paperAccountOptions(journalId, selectedId='') {
 const accounts=live.accounts.filter(a=>a.journal_id===journalId);
 const placeholder=!journalId?'请先选择期刊':accounts.length>1?'请选择投稿账号':'';
 return (placeholder?`<option value="" disabled ${!selectedId?'selected':''}>${placeholder}</option>`:'')+
  accounts.map(a=>`<option value="${esc(a.id)}" ${a.id===selectedId?'selected':''}>${esc(a.username)}</option>`).join('');
}

function paperForm(id='') {
 if(!live.accounts.length){view='accounts';render();toast('先添加一个期刊账号，再记录该账号下的稿件。');accountForm();return;}
 const p=id?live.manuscripts.find(x=>x.id===id):null;
 const journals=live.journals.filter(j=>live.accounts.some(a=>a.journal_id===j.id));
 const selectedJournal=p?live.accounts.find(a=>a.id===p.account_id)?.journal_id:(journals.some(j=>j.id===journalFilter)?journalFilter:journals.length===1?journals[0].id:'');
 modal(p?'编辑稿件':'添加稿件',`<p class="form-intro">${p?'英文题目用于在所选账号下定位稿件，中文题目用于展示。':'填写完整英文题目，已接入期刊的审稿中稿件会在保存后自动读取投稿信息。'}</p><div class="field"><label for="f-paper-journal">投稿期刊 <em>*</em></label><select id="f-paper-journal" required><option value="" disabled ${!selectedJournal?'selected':''}>请选择期刊</option>${journals.map(j=>`<option value="${esc(j.id)}" ${j.id===selectedJournal?'selected':''}>${esc(j.name)}</option>`).join('')}</select></div><div class="field"><label for="f-account_id">投稿账号 <em>*</em></label><select id="f-account_id" name="account_id" required ${!selectedJournal?'disabled':''}>${paperAccountOptions(selectedJournal,p?.account_id)}</select></div>${field('title_en','英文题目',p?.title_en||'','请填写投稿时的完整英文题目','text',true)}${p?field('title_zh','中文题目',p.title_zh||'','请输入对应的中文题目'):''}<div class="field-row"><div class="field"><label for="f-first_author">第一作者</label><input id="f-first_author" name="first_author" list="author-options" value="${esc(p?.first_author||'')}" placeholder="输入或选择第一作者姓名" maxlength="250"></div><div class="field"><label for="f-corresponding_author">通讯作者</label><input id="f-corresponding_author" name="corresponding_author" list="author-options" value="${esc(p?.corresponding_author||'')}" placeholder="输入或选择通讯作者姓名" maxlength="250"><datalist id="author-options">${[...new Set([live.profile?.name,...live.manuscripts.flatMap(p=>[p.first_author,p.corresponding_author])].filter(Boolean))].map(n=>`<option value="${n}"></option>`).join('')}</datalist></div></div>${p?`<div class="field-row">${field('number','稿件编号（可选）',p?.number||'','可在查询后补充')}${field('round','投稿轮次',p?.round||'初投','例如 第 1 轮修回')}</div>`:''}<div class="${p?'field-row':''}"><div class="field"><label for="f-status">状态分类 <em>*</em></label><select id="f-status" name="status">${(p?Object.entries(statuses):[['submitted','已投稿'],['review','审稿中'],['revision','待返修'],['accepted','已录用']]).map(([v,l])=>`<option value="${v}" ${(p?.status||'submitted')===v?'selected':''}>${l}</option>`).join('')}</select></div>${p?field('raw_status','网站原始状态',p.raw_status||'','例如 Under Review'):''}</div>${!p?`<div id="new-revision-fields" class="field-section hidden"><div class="field-row">${field('number','稿件编号（可选）','','例如 MS-2026-00123')}${field('round','投稿轮次','第 1 轮返修')}</div>${field('raw_status','网站原始状态（可选）','','按网站显示填写')}<div class="field-row">${field('status_date','返修决定日期','','','date')}${field('due_date','返修截止日期','','','date')}</div></div>`:''}${p?`<div class="field-row"><div class="field"><label for="f-system-submitted-at">投稿日期（期刊系统）</label><input id="f-system-submitted-at" value="${submissionDate(p)}" readonly><small>由期刊系统同步。</small></div>${field('status_date','网站状态日期',p?.status_date||'','','date')}</div>${field('due_date','返修截止日期',p?.due_date||'','','date')}<div class="field"><label for="f-notes">备注</label><textarea id="f-notes" name="notes" placeholder="可选">${esc(p?.notes||'')}</textarea></div>`:''}`,'paper',p?.id||'');
 updateRevisionFields();
}

document.addEventListener('click',async e=>{
 const target=e.target.closest('[data-action]'); if(!target)return;
 const {action,id}=target.dataset;
 if(action==='nav'){view=id;render();}
 else if(action==='tab'){tab=id;onlyUnread=false;savePreferences();render();}
 else if(action==='sort'){sort=sort==='priority'?'submission':'priority';savePreferences();render();}
 else if(action==='profile-settings')profileForm();
 else if(action==='schedule-settings')scheduleForm();
 else if(action==='background-reset')await saveBackground({reset:true});
 else if(action==='clear-filters'){search='';journalFilter='';authorFilter='';tab='all';onlyUnread=false;savePreferences();render();}
 else if(action==='unread-filter'){onlyUnread=!onlyUnread;if(onlyUnread){tab='all';search='';journalFilter='';authorFilter='';}render();}
 else if(action==='read-all'){onlyUnread=false;await markRead((live.notifications||[]).filter(n=>n.kind==='status').map(n=>n.id));}
 else if(action==='detail')detail(id);
 else if(action==='close-drawer')$('#drawer').close();
 else if(action==='close-modal'){$('#modal').close();$('#modal').innerHTML='';applyBackground();}
 else if(action==='add-account')accountForm('',id||'');
 else if(action==='edit-account')accountForm(id);
 else if(action==='connect-orcid'){await connectSso(id);}
 else if(action==='verify-orcid'){await connectSso(id,true);}
 else if(action==='verify-account'){await runRefresh({account_id:id,interactive:true});}
 else if(action==='add-paper')paperForm();
 else if(action==='edit-paper'){$('#drawer').close();paperForm(id);}
 else if(action==='show-password'){const input=$('#f-password');input.type=input.type==='password'?'text':'password';target.setAttribute('aria-label',input.type==='password'?'显示密码':'隐藏密码');}
 else if(action==='refresh'){
  await runRefresh();
 }
});
document.addEventListener('input',e=>{
 if(e.target.id==='search'){search=e.target.value;savePreferences();$('#paper-results').innerHTML=paperResults();}
 if(e.target.matches('[data-appearance-key]')){const value=Number(e.target.value),key=e.target.dataset.appearanceKey;$('#'+e.target.id+'-value').textContent=value+'%';e.target.setAttribute('aria-valuetext',value+'%');applyBackground({...live.appearance,[key]:value});}
});
document.addEventListener('change',e=>{
 if(e.target.id==='background-upload')uploadBackground(e.target.files[0]);
 if(e.target.matches('[data-appearance-key]'))saveBackground({[e.target.dataset.appearanceKey]:Number(e.target.value)});
 if(e.target.id==='f-paper-journal'){const account=$('#f-account_id');account.innerHTML=paperAccountOptions(e.target.value);account.disabled=!e.target.value;}
 if(e.target.id==='journal-filter'){journalFilter=e.target.value;savePreferences();render();}
 if(e.target.id==='author-filter'){authorFilter=e.target.value;savePreferences();$('#paper-results').innerHTML=paperResults();}
 if(e.target.id==='f-journal_id')updateAccountJournal();
 if(['f-login_method','f-platform'].includes(e.target.id))updateAccountAuth();
 if(e.target.id==='f-status')updateRevisionFields();
 if(e.target.name==='deadline_reminders'){const desktop=$('[name="deadline_desktop"]');desktop.disabled=!e.target.checked||!('Notification' in window);if(!e.target.checked)desktop.checked=false;}
});
document.addEventListener('submit',async e=>{
 if(e.target.id!=='editor-form')return;e.preventDefault();
 const form=e.target,body=Object.fromEntries(new FormData(form));
 const oldAccount=form.dataset.kind==='account'?live.accounts.find(a=>a.id===form.dataset.id):null;
 const credentialsChanged=oldAccount && (Boolean(body.password) || body.username!==oldAccount.username || body.login_method!==oldAccount.login_method);
 const button=form.querySelector('[type=submit]');button.disabled=true;button.textContent='正在保存…';$('#form-error').classList.add('hidden');
 try{
  if(form.dataset.kind==='profile') {
   await saveProfileForm(body);return;
  }
  if(form.dataset.kind==='schedule') {
   let permissionNote='';
   const notifications={deadline_reminders:body.deadline_reminders==='on',status_desktop:body.status_desktop==='on',deadline_desktop:body.deadline_desktop==='on'};
   if(!window.paperdesk&&(notifications.status_desktop||notifications.deadline_desktop)){
    let permission='Notification' in window?Notification.permission:'denied';
    if(permission==='default')permission=await Notification.requestPermission();
    if(permission!=='granted'){notifications.status_desktop=false;notifications.deadline_desktop=false;permissionNote='；桌面通知尚未获准，站内提醒正常显示';}
   }
   const result=await api('/api/settings',{enabled:body.enabled==='on',times:[body.time_0,body.time_1,body.time_2],notifications});
   $('#modal').close();$('#modal').innerHTML='';await load();render();toast(result.message+permissionNote);return;
  }
  const base=form.dataset.kind==='account'?'/api/accounts':'/api/manuscripts';
  const result=await api(base+(form.dataset.id?'/'+encodeURIComponent(form.dataset.id):''),body);
  if(body.password)body.password='';
  $('#modal').close();$('#modal').innerHTML='';await load();
  view=form.dataset.kind==='account'?'accounts':'overview';search='';journalFilter='';authorFilter='';tab='all';onlyUnread=false;savePreferences();render();toast(result.message);
  if(form.dataset.kind==='paper' && live.manuscripts.some(p=>p.id===result.id&&refreshable(p.status)))await runRefresh({manuscript_id:result.id});
  else if(credentialsChanged && live.manuscripts.some(p=>p.account_id===result.id&&refreshable(p.status)))await runRefresh({account_id:result.id});
 }catch(err){$('#form-error').textContent=err.message;$('#form-error').classList.remove('hidden');button.disabled=false;button.textContent='重新保存';}
});
$('#modal').addEventListener('cancel',()=>{$('#modal').innerHTML='';applyBackground();});
const drawer = $('#drawer');
let drawerPointerStartedOutside = false;
const outsideDrawer = event => {
 const rect = drawer.getBoundingClientRect();
 return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
};
drawer.addEventListener('pointerdown', event => {
 drawerPointerStartedOutside = event.target === drawer && outsideDrawer(event);
});
drawer.addEventListener('click', event => {
 if (drawerPointerStartedOutside && event.target === drawer && outsideDrawer(event)) drawer.close();
 drawerPointerStartedOutside = false;
});
load().then(async()=>{render();if(window.paperdesk)await initializeDesktop();}).catch(()=>{$('#app').innerHTML='<div class="boot"><h1>正在连接 Paperdesk</h1><p>后台正在准备。如果持续无法连接，请退出并重新打开应用。</p></div>';});

// Show background refresh results without interrupting an open form or active typing.
async function pollBackgroundState() {
 try {
  const next=await api('/api/state');
  deliverDesktop(next);
  if(document.hidden||$('#modal').open||$('#drawer').open||document.activeElement?.matches('input,textarea,select'))return;
  if(JSON.stringify(next)!==JSON.stringify(live)){live=next;render();}
 } catch {}
}
setInterval(pollBackgroundState,15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollBackgroundState();});
