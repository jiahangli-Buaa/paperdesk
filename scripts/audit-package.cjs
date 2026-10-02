const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const targets={
 'macos-arm64':path.join(root,'build/work/macos-arm64/mac-arm64/Paperdesk.app/Contents/Resources'),
 'windows-x64':path.join(root,'build/work/windows-x64/win-unpacked/resources')
};
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
 const file=path.join(dir,entry.name);return entry.isDirectory()?walk(file):[file];
});}
const reports=[];
for(const [target,resources] of Object.entries(targets)){
 if(!fs.existsSync(resources))continue;
 const files=walk(resources),relative=files.map(file=>path.relative(resources,file));
 const forbidden=relative.filter(file=>/(^|[/\\])(paperdesk\.sqlite3|browser-profiles|credentials|desktop-settings\.json|server\.log|\.links)([/\\]|$)/.test(file)||/session-state\.json$/.test(file));
 assert.deepEqual(forbidden,[],'Application must not include private runtime data');
 assert.ok(!fs.existsSync(path.join(resources,'runtime/browsers')),'Browsers are downloaded separately');
 assert.ok(fs.existsSync(path.join(resources,'src/desktop/install-components.cjs')),'Component installer required');
 assert.ok(fs.existsSync(path.join(resources,'src/desktop/browser-components.cjs')),'Shared component manager required');
 for(const file of ['src/backend/server.py','src/backend/backup.py','src/ui/app.js','src/ui/desktop.js','src/readers/scis_reader.mjs','src/readers/editorial_manager_reader.mjs','src/readers/papercept_reader.mjs','runtime/browser-module/playwright-core/index.mjs','runtime/runtime-manifest.json','app.asar'])assert.ok(fs.existsSync(path.join(resources,file)),file);
 const manifest=JSON.parse(fs.readFileSync(path.join(resources,'runtime/runtime-manifest.json')));
 assert.equal(manifest.target,target);
 if(target==='windows-x64'){
  for(const executable of [path.join(resources,'runtime/python/python.exe'),path.join(resources,'runtime/node/node.exe'),path.join(resources,'../Paperdesk.exe')]){
   const fd=fs.openSync(executable,'r'),header=Buffer.alloc(4096);fs.readSync(fd,header,0,header.length,0);fs.closeSync(fd);
   assert.equal(header.toString('ascii',0,2),'MZ');const pe=header.readUInt32LE(0x3c);assert.equal(header.readUInt16LE(pe+4),0x8664,'Windows executable must be x64');
  }
 }
 const asar=require('@electron/asar');
 const contents=asar.listPackage(path.join(resources,'app.asar')).map(name=>name.replaceAll('\\','/'));
 assert.ok(contents.includes('/src/desktop/main.cjs'));
 assert.ok(!contents.some(name=>name.includes('tests/')||name.includes('browser-profiles')));
 reports.push({target,ok:true,resourceFiles:files.length,privateRuntimeDataIncluded:false,runtime:manifest});
}
assert.ok(reports.length>0,'No packaged applications found');
fs.mkdirSync(path.join(root,'build/test-results'),{recursive:true});
fs.writeFileSync(path.join(root,'build/test-results/package-audit.json'),JSON.stringify(reports,null,2));
console.log(JSON.stringify(reports,null,2));
