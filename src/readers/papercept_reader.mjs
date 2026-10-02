// Read a PaperCept journal author's submissions using its PIN/login alias.
import {mkdir,chmod,writeFile} from 'node:fs/promises';
import {openReaderContext,closeReaderContext} from './reader_context.mjs';
import {paperceptRows} from './papercept_rows.mjs';
import {isPaperCeptUrl} from './portal_urls.mjs';

import {runReader} from './reader_worker.mjs';
let context, page, cookieHandlersReady=false;
async function read(input) {
const key=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
const wanted=row=>input.tracked.some(p=>p.number?key(p.number)===key(row.number):key(p.title_en)===key(row.title_en));
let stage='browser';
try {
  if(!isPaperCeptUrl(input.login_url) || input.login_method!=='password')throw new Error('unsupported_journal');
  await mkdir(input.profile_dir,{recursive:true,mode:0o700});
  if(process.platform!=='win32') await chmod(input.profile_dir,0o700);
  if(!context) {
    context=await openReaderContext(input,{headless:input.interactive!==true,viewport:{width:1280,height:900},timeout:30000});
    context.on('close',()=>{context=undefined;page=undefined;cookieHandlersReady=false;});
  }
  page=context.pages()[0]||await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(40000);
  stage='navigation';
  await page.goto(input.login_url,{waitUntil:'load'});
  stage='login';
  const pin=page.locator('form[name="login"] input[name="PIN"]');
  if(await pin.isVisible()) {
    await pin.fill(input.username);
    await page.locator('form[name="login"] input[name="Password"]').fill(input.password);
    input.password='';
    await page.getByRole('link',{name:'Log in',exact:true}).click();
    await page.waitForLoadState('load');
  }
  const author=page.getByRole('link',{name:/^Author(?:['’]s)?(?:\s+workspace)?$/i});
  if(/Access Page/i.test(await page.title()))stage='author';
  const deadline=Date.now()+(input.interactive?240000:20000);
  while(Date.now()<deadline && !await author.isVisible()) {
    const body=await page.locator('body').innerText();
    if(/(?:incorrect|invalid|wrong)\s+(?:PIN|password|login)|(?:PIN|password).{0,45}(?:incorrect|invalid|not found|does not match)/i.test(body))throw new Error('credentials_rejected');
    if(/agree.{0,45}terms|accept.{0,45}terms|account.{0,25}disabled/i.test(body) && !input.interactive)throw new Error('papercept_action_required');
    await page.waitForTimeout(300);
  }
  if(!await author.isVisible())throw new Error(stage==='author'?'read_incomplete':'login_incomplete');
  stage='author';
  await author.click();
  await page.waitForLoadState('load');
  stage='read';
  const tables=await page.locator('table').evaluateAll(elements=>elements.map(table=>[...table.rows].map(row=>[...row.cells].map(cell=>cell.innerText))));
  const result=paperceptRows(tables);
  if(!result.recognized)throw new Error('unrecognized_table');
  process.stdout.write(JSON.stringify({ok:true,rows:result.rows.filter(wanted)})+'\n');
} catch(error) {
  let code=stage==='browser'?'browser_unavailable':stage==='navigation'?'site_unavailable':stage==='login'?'login_incomplete':'read_incomplete';
  if(['unsupported_journal','credentials_rejected','papercept_action_required','login_incomplete','unrecognized_table'].includes(error.message))code=error.message;
  if(page) {
    const diagnostic={stage,error:error.name,title:await page.title().catch(()=> '')};
    diagnostic.visible=await page.evaluate(()=>({
      headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.innerText),
      links:[...document.querySelectorAll('a')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText}))
    })).catch(()=>null);
    if(stage==='author'||stage==='read') {
      diagnostic.page=await page.evaluate(()=>({
        headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.innerText),
        links:[...document.querySelectorAll('a')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText})),
        tables:[...document.querySelectorAll('table')].map(t=>[...t.rows].map(r=>[...r.cells].map(c=>c.innerText)))
      })).catch(()=>null);
      await page.screenshot({path:input.profile_dir+'/last-read-error.png'}).catch(()=>{});
    }
    await writeFile(input.profile_dir+'/last-read-error.json',JSON.stringify(diagnostic),{mode:0o600}).catch(()=>{});
  }
  process.stdout.write(JSON.stringify({ok:false,code})+'\n');
  if(!input.keep_browser) process.exitCode=1;
} finally {
  input.password='';
  if(context && !input.keep_browser) {await closeReaderContext(context).catch(()=>{});context=undefined;}
}

}
await runReader(read,async()=>{if(context)await closeReaderContext(context);context=undefined;});
