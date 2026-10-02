'use strict';
const path=require('node:path');
const {downloadComponents}=require('./browser-components.cjs');
const resources=path.resolve(__dirname,'../..');
const cache=process.argv[2];
if(!cache){console.error('Missing component destination');process.exit(1);}
const textMode=process.argv.includes('--text');
let lastLine='';
downloadComponents({node:process.execPath,moduleRoot:path.join(resources,'runtime/browser-module/playwright-core'),cache,
  onProgress:event=>{
    const line=textMode?event.label.replace('正在连接组件下载服务','Connecting to download service').replace('正在下载 ','Downloading ').replace('组件已下载，正在准备下一项','Preparing next component')+(event.percent===null?'':` - ${event.percent}%`):JSON.stringify(event);
    if(line!==lastLine){process.stdout.write(line+'\n');lastLine=line;}
  }
}).then(()=>{console.log(textMode?'Paperdesk components are ready.':JSON.stringify({label:'浏览器组件已就绪',percent:100,ready:true}));})
  .catch(error=>{console.error(error.message);process.exitCode=1;});
