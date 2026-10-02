const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {componentDirectories,componentsReady,downloadComponents}=require('../../src/desktop/browser-components.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'paperdesk-component-test-'));
const moduleRoot=path.join(root,'module'),cache=path.join(root,'cache');fs.mkdirSync(moduleRoot);
const metadata=require('../../node_modules/playwright-core/browsers.json');
fs.writeFileSync(path.join(moduleRoot,'browsers.json'),JSON.stringify(metadata));
const directories=componentDirectories(moduleRoot,cache);
fs.mkdirSync(directories[0],{recursive:true});
assert.equal(componentsReady(moduleRoot,cache),false,'An interrupted extraction is not ready');
fs.writeFileSync(path.join(moduleRoot,'cli.js'),`
 const fs=require('node:fs'),path=require('node:path');
 const directories=${JSON.stringify(directories)};
 const failed=path.join(__dirname,'failed-once');
 for(const dir of directories){
   fs.mkdirSync(dir,{recursive:true});
   console.log('Downloading Test component from https://example.test/browser.zip');
   console.log('| progress | 100%');
   fs.writeFileSync(path.join(dir,'INSTALLATION_COMPLETE'),'');
   if(!fs.existsSync(failed)){fs.writeFileSync(failed,'');process.exit(1);}
 }
`);
(async()=>{
 const events=[];
 const options={node:process.execPath,moduleRoot,cache,onProgress:e=>events.push(e)};
 await assert.rejects(downloadComponents(options),/组件下载未完成/);
 assert.equal(componentsReady(moduleRoot,cache),false);
 assert.ok(fs.existsSync(path.join(directories[0],'INSTALLATION_COMPLETE')),'Completed download survives a later failure');
 assert.equal((await downloadComponents(options)).downloaded,true);
 assert.equal(componentsReady(moduleRoot,cache),true);
 assert.ok(events.some(e=>e.percent===100));
 assert.equal((await downloadComponents({...options,node:path.join(root,'missing-node')})).downloaded,false,'Ready components need no network or child process');
 metadata.browsers.find(b=>b.name==='firefox').revision='999999';
 fs.writeFileSync(path.join(moduleRoot,'browsers.json'),JSON.stringify(metadata));
 assert.equal(componentsReady(moduleRoot,cache),false,'A new browser revision must be downloaded');
 console.log('Component download failure, retry, progress, cache reuse and revision changes passed.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
