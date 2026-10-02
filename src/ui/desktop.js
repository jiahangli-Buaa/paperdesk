'use strict';
let desktopInfo={preferences:{keepRunning:true,startAtLogin:false}};
async function desktopCall(operation){
 const result=await operation();if(result?.error)throw new Error(result.error);return result;
}
async function initializeDesktop(){
 desktopInfo=await desktopCall(()=>window.paperdesk.info());
 window.paperdesk.onAction(async action=>{
  if(action==='settings'){if($('#modal').open)$('#modal').close();scheduleForm();}
  if(action==='profile'||action==='about'){if($('#modal').open)$('#modal').close();profileForm();}
  if(action==='refresh')await runRefresh();
  if(action==='notifications'){view='history';await load();render();}
 });
 if(!live.profile?.onboarding_complete)profileForm(true);
}
function profileForm(welcome=false){
 const profile=live.profile||{},prefs=desktopInfo.preferences||{};
 const zone=profile.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone;
 const zones=[...new Set([zone,Intl.DateTimeFormat().resolvedOptions().timeZone,'Asia/Shanghai','Asia/Hong_Kong','Asia/Tokyo','Asia/Singapore','Europe/London','Europe/Berlin','America/New_York','America/Los_Angeles','Australia/Sydney','UTC'])];
 const zoneLabels={'Asia/Shanghai':'中国标准时间','Asia/Hong_Kong':'香港','Asia/Tokyo':'东京','Asia/Singapore':'新加坡','Europe/London':'伦敦','Europe/Berlin':'柏林','America/New_York':'纽约','America/Los_Angeles':'洛杉矶','Australia/Sydney':'悉尼','UTC':'世界协调时间'};
 modal(welcome?'欢迎使用 Paperdesk':'个人与数据',`
 ${welcome?'<div class="welcome-intro"><div class="welcome-mark">P</div><h3>让投稿进度一目了然</h3><p>设置你的署名，随后添加期刊账号和需要跟踪的论文。</p><div class="setup-steps"><span><b>1</b>设置署名</span><span><b>2</b>添加账号</span><span><b>3</b>跟踪稿件</span></div></div>':''}
 ${field('name','我的姓名',profile.name||'','例如：张三','text',true)}
 ${field('aliases','其他署名',(profile.aliases||[]).join('；'),'例如：San Zhang；Zhang San')}
 <p class="form-intro">用于识别你的第一作者和通讯作者论文。多个署名用分号分隔。</p>
 <div class="field"><label for="f-timezone">刷新与提醒时区</label><select id="f-timezone" name="timezone">${zones.map(z=>`<option value="${esc(z)}" ${z===zone?'selected':''}>${esc(zoneLabels[z]||z)} · ${esc(z)}</option>`).join('')}</select></div>
 ${welcome?'':`<h3 class="settings-section-title settings-divider">桌面应用</h3>
 <label class="schedule-toggle"><input type="checkbox" name="keepRunning" ${prefs.keepRunning?'checked':''}>关闭窗口后继续后台刷新</label>
 <label class="schedule-toggle"><input type="checkbox" name="startAtLogin" ${prefs.startAtLogin?'checked':''}>登录电脑时启动 Paperdesk</label>
 <p class="form-intro">可从菜单栏或托盘重新打开。选择“退出 Paperdesk”会停止后台任务。</p>
 <h3 class="settings-section-title settings-divider">稿件与设置</h3>
 <div class="desktop-data-actions"><button type="button" class="btn" data-desktop="backup">导出备份</button><button type="button" class="btn" data-desktop="restore">从备份恢复</button>${desktopInfo.legacyAvailable?'<button type="button" class="btn" data-desktop="legacy">导入旧版 Mac 数据</button>':''}</div>
 <p class="form-intro">备份包含稿件、历史与设置。恢复后重新连接投稿账号。</p>
 <div class="desktop-about"><span>Paperdesk ${esc(desktopInfo.version||'')}</span><button type="button" class="text-btn" data-desktop="updates">检查更新</button><button type="button" class="text-btn" data-desktop="data">打开数据目录</button></div>`}
 ${welcome&&desktopInfo.legacyAvailable?'<p class="form-intro"><button type="button" class="text-btn" data-desktop="legacy">导入这台 Mac 上的旧版数据</button></p>':''}
 `,'profile');
 $('#editor-form').dataset.welcome=welcome?'true':'false';
 $('#editor-form [type=submit]').textContent=welcome?'保存并开始':'保存设置';
}
async function saveProfileForm(body){
 const welcome=$('#editor-form').dataset.welcome==='true';
 const result=await api('/api/profile',{name:body.name,aliases:String(body.aliases||'').split(/[；;、\n]+/).map(v=>v.trim()).filter(Boolean),timezone:body.timezone});
 const saved=await desktopCall(()=>window.paperdesk.preferences({keepRunning:welcome?desktopInfo.preferences.keepRunning:body.keepRunning==='on',startAtLogin:welcome?desktopInfo.preferences.startAtLogin:body.startAtLogin==='on'}));
 desktopInfo.preferences=saved.preferences;
 $('#modal').close();$('#modal').innerHTML='';await load();render();
 if(welcome&&!live.accounts.length){view='accounts';render();accountForm();toast('设置已保存，添加第一个期刊账号即可开始。');}
 else toast(result.message);
}
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-desktop]');if(!button||!window.paperdesk)return;
 button.disabled=true;
 try{
  const actions={backup:window.paperdesk.backup,restore:window.paperdesk.restore,legacy:window.paperdesk.importLegacy,updates:window.paperdesk.checkUpdates,data:window.paperdesk.openDataFolder};
  const result=await desktopCall(actions[button.dataset.desktop]);
  if(result?.cancelled)return;
  if(result?.message)toast(result.message);
  if(['restore','legacy'].includes(button.dataset.desktop)&&result?.ok){
   $('#modal').close();await load();render();profileForm(!live.profile?.onboarding_complete);
  }
 }catch(error){toast(error.message);}finally{button.disabled=false;}
});
