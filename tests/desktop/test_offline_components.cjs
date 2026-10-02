const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {componentDirectories,componentCacheDirectory,downloadComponents}=require('../../src/desktop/browser-components.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'paperdesk-offline-components-'));
const runtime=path.join(root,'runtime'),dataPath=path.join(root,'user'),moduleRoot=path.join(runtime,'browser-module/playwright-core');
const bundled=path.join(runtime,'browsers');
fs.mkdirSync(moduleRoot,{recursive:true});
fs.copyFileSync(path.join(__dirname,'../../node_modules/playwright-core/browsers.json'),path.join(moduleRoot,'browsers.json'));
const options={runtime,dataPath,packaged:true,platform:'win32'};
(async()=>{
 assert.equal(componentCacheDirectory(options),path.join(dataPath,'components'),'Online installs keep the existing user cache');
 const directories=componentDirectories(moduleRoot,bundled,'win32');
 assert.equal(directories.length,5,'Include the Windows runtime helper as well as both browser engines');
 for(const directory of directories){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'INSTALLATION_COMPLETE'),'');}
 assert.equal(componentCacheDirectory(options),bundled,'Offline installs use bundled components with an empty user cache');
 assert.equal((await downloadComponents({node:path.join(root,'no-downloader'),moduleRoot,cache:bundled})).downloaded,false,'Complete bundled components do not launch a downloader');
 assert.equal(componentCacheDirectory({...options,override:'explicit-test-cache'}),'explicit-test-cache');
 assert.equal(componentCacheDirectory({...options,packaged:false}),bundled);
 console.log('Offline component selection, Windows completeness, no downloader, and online cache compatibility passed.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
