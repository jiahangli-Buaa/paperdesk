const path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const executable=process.platform==='darwin'
 ?path.join(root,'build/work/macos-arm64/mac-arm64/Paperdesk.app/Contents/MacOS/Paperdesk')
 :path.join(root,'build/work/windows-x64-offline/win-unpacked/Paperdesk.exe');
const runtime=process.platform==='darwin'?path.resolve(executable,'../../Resources/runtime'):path.join(path.dirname(executable),'resources/runtime');
const result=spawnSync(process.execPath,[path.join(root,'scripts/smoke-desktop.cjs')],{
 cwd:root,stdio:'inherit',env:{...process.env,PAPERDESK_TEST_EXECUTABLE:executable,PAPERDESK_TEST_RUNTIME:runtime,PAPERDESK_TEST_COMPONENTS_DIR:path.join(runtime,'browsers')}});
if(result.error)throw result.error;
process.exit(result.status===null?1:result.status);
