const path=require('node:path');
const {componentsReady}=require('../../src/desktop/browser-components.cjs');
const config=require('./electron-builder.cjs');
const root=path.resolve(__dirname,'../..');
const runtime=path.join(root,'build/runtime/windows-x64');
const version=require('../../package.json').version.replace(/\.0$/,'');
if(!componentsReady(path.join(runtime,'browser-module/playwright-core'),path.join(runtime,'browsers'),'win32')){
  throw new Error('Prepare the complete Windows runtime on Windows before building the offline installer.');
}
module.exports={
  ...config,
  directories:{...config.directories,output:path.join(root,'build/work/windows-x64-offline')},
  extraResources:[...config.extraResources,
    {from:path.join(runtime,'browsers'),to:'runtime/browsers',filter:['**/*','!.links{,/**/*}','!**/.DS_Store']}],
  nsis:{...config.nsis,include:'build/config/installer-offline.nsh',artifactName:`Paperdesk-${version}-Windows-Offline.exe`}
};
