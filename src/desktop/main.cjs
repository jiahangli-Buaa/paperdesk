'use strict';
const {app,BrowserWindow,Menu,Tray,nativeImage,protocol,net,dialog,ipcMain,shell,Notification,powerMonitor} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const {releaseFor,displayVersion} = require('./update.cjs');
const {componentsReady,componentCacheDirectory} = require(app.isPackaged?path.join(process.resourcesPath,'src/desktop/browser-components.cjs'):'./browser-components.cjs');

protocol.registerSchemesAsPrivileged([{scheme:'paperdesk',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
const project = path.resolve(__dirname,'../..');
const target = process.platform==='darwin'?'macos-arm64':'windows-x64';
const resources = app.isPackaged?process.resourcesPath:project;
const runtime = app.isPackaged?path.join(resources,'runtime'):path.join(project,'build/runtime',target);
const source = app.isPackaged?path.join(resources,'src'):path.join(project,'src');
const assets = app.isPackaged?path.join(resources,'assets'):path.join(project,'assets');
const dataPath = process.env.PAPERDESK_TEST_DATA_DIR || (process.platform==='darwin'
  ?path.join(app.getPath('appData'),'PaperdeskDesktop'):path.join(process.env.LOCALAPPDATA || app.getPath('appData'),'Paperdesk'));
app.setPath('userData',dataPath);
app.setName('Paperdesk');
const componentCache=componentCacheDirectory({runtime,dataPath,packaged:app.isPackaged,override:process.env.PAPERDESK_TEST_COMPONENTS_DIR});
if(process.platform==='win32') app.setAppUserModelId('org.paperdesk.desktop');
const singleInstance = app.requestSingleInstanceLock();
let window, tray, backend, backendBase, quitting=false, stopped=false, notificationTimer, notificationBusy=false;
let restartCount=0;
let componentInstaller;
const token=crypto.randomBytes(32).toString('base64url');
const configPath=path.join(dataPath,'desktop-settings.json');
const defaults={keepRunning:true,startAtLogin:false};
function readConfig(){try{return {...defaults,...JSON.parse(fs.readFileSync(configPath,'utf8'))};}catch{return {...defaults};}}
let preferences=readConfig();
function saveConfig(){fs.mkdirSync(dataPath,{recursive:true});fs.writeFileSync(configPath,JSON.stringify(preferences,null,2),{mode:0o600});}
function log(message){fs.mkdirSync(path.join(dataPath,'logs'),{recursive:true});fs.appendFileSync(path.join(dataPath,'logs/desktop.log'),`${new Date().toISOString()} ${message}\n`);}
function showWindow(){if(!window || window.isDestroyed())return;if(window.isMinimized())window.restore();window.show();window.focus();}
function action(name){showWindow();window?.webContents.send('desktop:action',name);}
async function api(endpoint,body){
  if(!backendBase)throw new Error('后台尚未就绪，请稍候');
  const response=await fetch(backendBase+endpoint,{method:body===undefined?'GET':'POST',
    headers:{'X-Paperdesk-Token':token,'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'操作未完成');return value;
}
function startBackend(){return new Promise((resolve,reject)=>{
  const python=process.platform==='darwin'?path.join(runtime,'python/bin/python3'):path.join(runtime,'python/python.exe');
  const node=process.platform==='darwin'?path.join(runtime,'node/bin/node'):path.join(runtime,'node/node.exe');
  if(!fs.existsSync(python)||!fs.existsSync(node))return reject(new Error('运行组件缺失，请重新安装完整安装包。'));
  const env={...process.env,PAPERDESK_DATA_DIR:dataPath,PAPERDESK_SESSION_TOKEN:token,
    PAPERDESK_NODE:node,PAPERDESK_BROWSER_MODULE:path.join(runtime,'browser-module/playwright-core/index.mjs'),
    PAPERDESK_KEYCHAIN_HELPER:path.join(runtime,'keychain-helper'),
    PAPERDESK_TIMEZONE:Intl.DateTimeFormat().resolvedOptions().timeZone,
    PLAYWRIGHT_BROWSERS_PATH:componentCache,PYTHONTZPATH:path.join(runtime,'tzdata/zoneinfo'),
    PYTHONUTF8:'1',PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1'};
  delete env.PYTHONHOME;delete env.PYTHONPATH;
  const child=spawn(python,['-B','-c','import sys,runpy,os; script=sys.argv.pop(1); sys.path.insert(0,os.path.dirname(script)); runpy.run_path(script,run_name="__main__")',path.join(source,'backend/server.py'),'--port','0'],{
    cwd:path.join(source,'backend'),env,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  backend=child;
  let ready=false;
  const timeout=setTimeout(()=>{child.kill();reject(new Error('后台启动超时，请重新打开 Paperdesk。'));},25000);
  readline.createInterface({input:child.stdout}).on('line',line=>{
    try{const event=JSON.parse(line);if(event.type==='ready'&&Number.isInteger(event.port)){
      ready=true;clearTimeout(timeout);backendBase='http://127.0.0.1:'+event.port;resolve();
    }}catch{/* Only the readiness event is used. */}
  });
  child.stderr.on('data',data=>log('backend: '+String(data).slice(0,8000)));
  child.on('error',error=>{clearTimeout(timeout);reject(error);});
  child.on('exit',()=>{
    clearTimeout(timeout);
    if(!ready)return reject(new Error('后台未能启动，请查看应用数据目录中的日志。'));
    if(quitting)return;
    backendBase=null;
    if(restartCount++<1)startBackend().then(()=>window?.reload()).catch(error=>dialog.showErrorBox('Paperdesk',error.message));
    else dialog.showErrorBox('后台已停止','请退出并重新打开 Paperdesk。已保存的稿件保留在本机。');
  });
});}
async function stopBackend(){
  if(stopped)return;stopped=true;
  clearInterval(notificationTimer);
  if(componentInstaller&&componentInstaller.exitCode===null){
    if(process.platform==='win32')await new Promise(resolve=>spawn('taskkill',['/pid',String(componentInstaller.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).once('exit',resolve));
    else {try{process.kill(-componentInstaller.pid,'SIGTERM');}catch{componentInstaller.kill();}}
  }
  const child=backend;
  if(!child || child.exitCode!==null)return;
  try{await api('/api/shutdown',{});}catch{}
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,10000))]);
  if(child.exitCode===null){
    if(process.platform==='win32')await new Promise(resolve=>spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).once('exit',resolve));
    else {try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}
  }
}
function allowExternal(url){try{return new URL(url).protocol==='https:';}catch{return false;}}
function createWindow(setup=false){
  window=new BrowserWindow({width:1280,height:850,minWidth:940,minHeight:640,show:false,
    title:'Paperdesk · 投稿工作台',backgroundColor:'#f4f7fb',icon:path.join(assets,'icon.png'),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.once('ready-to-show',()=>{if(setup||!process.argv.includes('--hidden'))window.show();});
  window.on('close',event=>{if(!quitting&&preferences.keepRunning&&backendBase){event.preventDefault();window.hide();}});
  window.webContents.setWindowOpenHandler(({url})=>{if(allowExternal(url))shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('paperdesk://app/')){event.preventDefault();if(allowExternal(url))shell.openExternal(url);}});
  window.webContents.on('render-process-gone',()=>{if(!quitting)window.reload();});
  return setup?window.loadFile(path.join(__dirname,'setup.html')):window.loadURL('paperdesk://app/');
}
async function prepareComponents(){
  if(componentsReady(path.join(runtime,'browser-module/playwright-core'),componentCache))return;
  await createWindow(true);
  while(!quitting){
    try{
      await new Promise((resolve,reject)=>{
        const node=process.platform==='darwin'?path.join(runtime,'node/bin/node'):path.join(runtime,'node/node.exe');
        const child=spawn(node,[path.join(source,'desktop/install-components.cjs'),componentCache],{
          windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
        componentInstaller=child;
        readline.createInterface({input:child.stdout}).on('line',line=>{
          try{const event=JSON.parse(line);if(!window?.isDestroyed())window?.webContents.send('desktop:setup-progress',event);}catch{}
        });
        child.stderr.on('data',data=>log('components: '+String(data).slice(0,4000)));
        child.on('error',reject);
        child.on('exit',code=>{componentInstaller=null;code===0?resolve():reject(new Error('请检查网络连接。已完成的组件会保留，重试会继续准备。'));});
      });
      return;
    }catch(error){
      if(quitting)return;
      const choice=await dialog.showMessageBox(window,{type:'warning',buttons:['重试','退出'],defaultId:0,cancelId:1,
        message:'组件下载未完成',detail:error.message});
      if(choice.response!==0){app.quit();return;}
    }
  }
}
function createMenus(){
  const applicationMenu=[{label:'Paperdesk',submenu:[{label:'关于 Paperdesk',click:()=>action('about')},{label:'设置',accelerator:'CmdOrCtrl+,',click:()=>action('settings')},{type:'separator'},{label:'退出 Paperdesk',accelerator:'CmdOrCtrl+Q',click:()=>app.quit()}]},
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'窗口',submenu:[{role:'minimize'},{label:'显示主窗口',click:showWindow},{role:'togglefullscreen'}]},
    {label:'帮助',submenu:[{label:'备份与恢复',click:()=>action('profile')},{label:'检查更新',click:()=>checkUpdates()},{label:'打开数据目录',click:()=>shell.openPath(dataPath)}]}];
  if(!app.isPackaged)applicationMenu[2].submenu.push({role:'toggleDevTools'});
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu));
  const trayImage=nativeImage.createFromPath(path.join(assets,process.platform==='darwin'?'trayTemplate.png':'icon.png')).resize({width:20,height:20});
  if(process.platform==='darwin')trayImage.setTemplateImage(true);
  tray=new Tray(trayImage);tray.setToolTip('Paperdesk · 投稿工作台');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 Paperdesk',click:showWindow},{label:'刷新审稿中',click:()=>action('refresh')},{type:'separator'},{label:'退出',click:()=>app.quit()}]));
  tray.on('click',showWindow);
}
async function notifyChanges(){
  if(notificationBusy || !backendBase || !Notification.isSupported())return;
  notificationBusy=true;
  try{
    const state=await api('/api/state');const prefs=state.notification_settings||{};
    const notices=(state.notifications||[]).filter(n=>!n.desktop_at&&prefs[n.kind==='status'?'status_desktop':'deadline_desktop']);
    if(!notices.length)return;
    const result=await api('/api/notifications/claim',{ids:notices.map(n=>n.id)});
    const claimed=notices.filter(n=>result.ids.includes(n.id));if(!claimed.length)return;
    const paper=state.manuscripts.find(p=>p.id===claimed[0].manuscript_id);
    const notice=new Notification({title:claimed.length===1?'Paperdesk · 投稿提醒':`Paperdesk · ${claimed.length} 条新提醒`,
      body:claimed.length===1?`${paper?.title_en||paper?.title||''}\n${claimed[0].kind==='deadline'?'返修截止日期临近':paper?.raw_status||'投稿状态已更新'}`:'打开 Paperdesk 查看状态变化和返修提醒。'});
    notice.on('click',()=>action('notifications'));notice.show();
  }catch{}finally{notificationBusy=false;}
}
async function backupData(){
  const chosen=await dialog.showSaveDialog(window,{title:'备份稿件和设置',defaultPath:`Paperdesk-${new Date().toISOString().slice(0,10)}.paperdesk`,filters:[{name:'Paperdesk 备份',extensions:['paperdesk']}]});
  if(chosen.canceled)return {cancelled:true};
  const result=await api('/api/backup/export',{});fs.writeFileSync(chosen.filePath,Buffer.from(result.data,'base64'),{mode:0o600});
  return {ok:true,message:'备份已保存，包含稿件、历史和设置。'};
}
async function restoreData(legacy=false){
  let data;
  if(!legacy){const chosen=await dialog.showOpenDialog(window,{title:'选择 Paperdesk 备份',properties:['openFile'],filters:[{name:'Paperdesk 备份',extensions:['paperdesk']}]});
    if(chosen.canceled)return {cancelled:true};
    if(fs.statSync(chosen.filePaths[0]).size>128*1024*1024)throw new Error('备份文件过大');
    data=fs.readFileSync(chosen.filePaths[0]).toString('base64');}
  const choice=await dialog.showMessageBox(window,{type:'question',buttons:['恢复数据','取消'],defaultId:1,cancelId:1,
    message:legacy?'导入本机旧版 Paperdesk 数据？':'用备份恢复稿件和设置？',
    detail:'当前数据会先备份到本机。恢复后需要重新保存投稿账号密码。'});
  if(choice.response!==0)return {cancelled:true};
  return api(legacy?'/api/backup/legacy':'/api/backup/restore',legacy?{}:{data});
}
async function checkUpdates(){
  const config=JSON.parse(fs.readFileSync(path.join(resources,app.isPackaged?'release-config.json':'build/config/release-config.json'),'utf8'));
  if(!config.updateManifestUrl){await shell.openExternal(config.downloadPageUrl);return {configured:false};}
  try{
    if(!allowExternal(config.updateManifestUrl))throw new Error('更新地址需要使用 HTTPS');
    const response=await fetch(config.updateManifestUrl,{signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('暂时无法检查更新');
    const result=releaseFor(await response.json(),target,app.getVersion());
    if(!result.newer){await dialog.showMessageBox(window,{message:'已是最新版本',detail:displayVersion(app.getVersion())});return result;}
    const choice=await dialog.showMessageBox(window,{type:'info',buttons:['下载新版','稍后'],cancelId:1,message:'发现 Paperdesk '+result.version,detail:result.notes||'下载后覆盖安装，稿件和设置会保留。'});
    if(choice.response===0)await shell.openExternal(result.url);return result;
  }catch(error){await dialog.showMessageBox(window,{type:'warning',message:'检查更新未完成',detail:error.message});return {error:error.message};}
}
function registerIpc(){
  function handle(name,callback){ipcMain.handle('desktop:'+name,async(event,value)=>{
    if(!event.senderFrame?.url.startsWith('paperdesk://app/'))throw new Error('无效页面');
    try{return await callback(value);}catch(error){return {error:error.message};}
  });}
  handle('info',()=>({version:displayVersion(app.getVersion()),platform:process.platform,arch:process.arch,preferences,
    legacyAvailable:process.platform==='darwin'&&fs.existsSync(path.join(app.getPath('appData'),'Paperdesk/paperdesk.sqlite3'))}));
  handle('preferences',value=>{
    if(typeof value?.keepRunning!=='boolean'||typeof value?.startAtLogin!=='boolean')throw new Error('设置格式无效');
    if(app.isPackaged)app.setLoginItemSettings({openAtLogin:value.startAtLogin,args:['--hidden']});
    preferences={keepRunning:value.keepRunning,startAtLogin:app.isPackaged&&value.startAtLogin};saveConfig();return {ok:true,preferences};
  });
  handle('backup',backupData);handle('restore',()=>restoreData(false));handle('legacy',()=>restoreData(true));
  handle('updates',checkUpdates);handle('open-data',()=>shell.openPath(dataPath));
}
if(!singleInstance){app.quit();}else{
  app.on('second-instance',showWindow);
  app.on('activate',()=>{if(!window||window.isDestroyed())createWindow();else showWindow();});
  app.on('window-all-closed',()=>{if(!backendBase||!preferences.keepRunning)app.quit();});
  app.on('before-quit',event=>{if(stopped)return;event.preventDefault();quitting=true;stopBackend().finally(()=>app.quit());});
  app.whenReady().then(async()=>{
    await prepareComponents();
    if(quitting)return;
    await startBackend();
    protocol.handle('paperdesk',async request=>{
      const requested=new URL(request.url);
      if(requested.hostname!=='app')return new Response('Not found',{status:404});
      if(!backendBase)return new Response('服务正在恢复',{status:503});
      const headers={'X-Paperdesk-Token':token};
      for(const name of ['content-type','x-paperdesk-filename'])if(request.headers.has(name))headers[name]=request.headers.get(name);
      return net.fetch(backendBase+requested.pathname+requested.search,{method:request.method,headers,
        body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer()});
    });
    registerIpc();if(window&&!window.isDestroyed())window.loadURL('paperdesk://app/');else createWindow();createMenus();
    notificationTimer=setInterval(notifyChanges,15000);
    powerMonitor.on('resume',()=>{notifyChanges();});
  }).catch(error=>{dialog.showErrorBox('Paperdesk 未能启动',error.message);app.quit();});
}
