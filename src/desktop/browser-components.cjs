'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {spawn}=require('node:child_process');

function componentDirectories(moduleRoot,cache,platform=process.platform){
  const names=['chromium','chromium-headless-shell','firefox','ffmpeg'];
  if(platform==='win32')names.push('winldd');
  const metadata=JSON.parse(fs.readFileSync(path.join(moduleRoot,'browsers.json'),'utf8'));
  return names.map(name=>{
    const browser=metadata.browsers.find(item=>item.name===name);
    if(!browser)throw new Error('浏览器组件配置缺失，请重新安装 Paperdesk。');
    return path.join(cache,`${name.replaceAll('-','_')}-${browser.revision}`);
  });
}
function componentsReady(moduleRoot,cache,platform=process.platform){
  return componentDirectories(moduleRoot,cache,platform).every(directory=>
    fs.existsSync(path.join(directory,'INSTALLATION_COMPLETE')));
}
function componentCacheDirectory({runtime,dataPath,packaged,override,platform=process.platform}){
  if(override)return override;
  const bundled=path.join(runtime,'browsers');
  if(!packaged||componentsReady(path.join(runtime,'browser-module/playwright-core'),bundled,platform))return bundled;
  return path.join(dataPath,'components');
}
function downloadComponents({node,moduleRoot,cache,onProgress=()=>{},onChild=()=>{}}){
  if(componentsReady(moduleRoot,cache))return Promise.resolve({downloaded:false});
  fs.mkdirSync(cache,{recursive:true});
  return new Promise((resolve,reject)=>{
    const child=spawn(node,[path.join(moduleRoot,'cli.js'),'install','chromium','firefox'],{
      windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
        PLAYWRIGHT_BROWSERS_PATH:cache,PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:'120000',
        PLAYWRIGHT_SKIP_BROWSER_GC:'1',CI:'1'}});
    onChild(child);
    let label='正在连接组件下载服务',lastError='';
    for(const stream of [child.stdout,child.stderr])readline.createInterface({input:stream}).on('line',line=>{
      const match=line.match(/^Downloading (.+?)(?: from|$)/);
      if(match)label='正在下载 '+match[1].replace(/ \(.*$/,'');
      const percent=line.match(/(\d+)%/);
      if(/downloaded to/.test(line))label='组件已下载，正在准备下一项';
      if(/Error:|Download failure|timed out|ENOTFOUND|ECONN/.test(line))lastError=line.slice(0,500);
      onProgress({label,percent:percent?Number(percent[1]):null});
    });
    child.on('error',reject);
    child.on('exit',code=>{
      onChild(null);
      if(code===0&&componentsReady(moduleRoot,cache))resolve({downloaded:true});
      else reject(new Error('组件下载未完成，请检查网络后重试。已完成的组件会保留。'+(lastError?'\n'+lastError:'')));
    });
  });
}
module.exports={componentDirectories,componentsReady,componentCacheDirectory,downloadComponents};
