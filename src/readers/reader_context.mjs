// Each account retains its existing browser profile and its own authenticated context.
import {mkdir,chmod} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export async function openReaderContext(input,options) {
  await mkdir(input.profile_dir,{recursive:true,mode:0o700});
  if(process.platform!=='win32') await chmod(input.profile_dir,0o700);
  const module=await import(pathToFileURL(input.browser_module).href);
  const type=module[input.browser_engine==='firefox'?'firefox':'chromium'];
  const context=await type.launchPersistentContext(input.profile_dir,options);
  if(input.reset_session) {
    await context.clearCookies();
    await context.addInitScript(()=>{sessionStorage.clear();localStorage.clear();});
  }
  return context;
}
export async function closeReaderContext(context) {await context.close();}
