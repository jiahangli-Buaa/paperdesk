const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),target=process.platform==='darwin'?'macos-arm64':'windows-x64';
const runtime=process.env.PAPERDESK_TEST_RUNTIME||path.join(root,'build/runtime',target);
process.env.PLAYWRIGHT_BROWSERS_PATH=process.env.PAPERDESK_TEST_COMPONENTS_DIR||path.join(runtime,'browsers');
(async()=>{
 const tools=await import(pathToFileURL(path.join(runtime,'browser-module/playwright-core/index.mjs')).href);
 const checks=[];
 for(const name of ['chromium','firefox']){
  const browser=await tools[name].launch({headless:true});
  try{const page=await browser.newPage();await page.setContent('<title>Paperdesk runtime check</title><p>runtime ready</p>');
   if(await page.title()!=='Paperdesk runtime check')throw new Error(name+' failed');
   checks.push({engine:name,version:browser.version(),ok:true});
  }finally{await browser.close();}
 }
 fs.mkdirSync(path.join(root,'build/test-results'),{recursive:true});
 fs.writeFileSync(path.join(root,'build/test-results/browser-smoke-'+target+'.json'),JSON.stringify(checks,null,2));
 console.log(JSON.stringify(checks));
})().catch(error=>{console.error(error);process.exit(1);});
