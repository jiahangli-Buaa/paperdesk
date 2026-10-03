const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version.replace(/\.0$/,'');
const outputs=[['macos-arm64',`Paperdesk-${version}-Mac.dmg`],['windows-x64-offline',`Paperdesk-${version}-Windows-Offline.exe`]];
const artifacts=[];
for(const [buildTarget,file] of outputs){
 const target=buildTarget.replace(/-offline$/,'');
 const source=path.join(root,'build/work',buildTarget,file);
 if(!fs.existsSync(source))continue;
 const directory=path.join(root,'release',target);fs.mkdirSync(directory,{recursive:true});
 fs.copyFileSync(source,path.join(directory,file));
 artifacts.push({target,variant:'offline',file:target+'/'+file,bytes:fs.statSync(source).size});
}
if(!artifacts.length)throw new Error('No installers have been built.');
fs.writeFileSync(path.join(root,'release/release-manifest.json'),JSON.stringify({version,channel:'stable',artifacts},null,2));
console.log(JSON.stringify(artifacts,null,2));
