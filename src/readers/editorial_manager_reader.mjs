// Read the account's author queues. Never open submission-edit or correspondence actions.
import {mkdir, chmod, writeFile} from 'node:fs/promises';
import {openReaderContext,closeReaderContext} from './reader_context.mjs';
import {isEditorialManagerUrl} from './portal_urls.mjs';
import {readEditorialManagerTable,expandEditorialManagerPage} from './editorial_manager_rows.mjs';
import {ensureEditorialManagerLogin} from './editorial_manager_login.mjs';

import {runReader} from './reader_worker.mjs';
let context, page, cookieHandlersReady=false;
async function read(input) {
const baseNumber = value => String(value || '').replace(/(?:\.R|R)\d+$/i, '');
const key = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const wanted = row => input.tracked.some(paper => paper.number
  ? baseNumber(paper.number) === baseNumber(row.number) : key(paper.title_en) === key(row.title_en));
let stage = 'browser';

try {
  if (!isEditorialManagerUrl(input.login_url) || input.login_method !== 'password') throw new Error('unsupported_journal');
  await mkdir(input.profile_dir, {recursive: true, mode: 0o700});
  if(process.platform!=='win32') await chmod(input.profile_dir, 0o700);
  if(!context) {
    context=await openReaderContext(input, {
    
    headless: input.interactive !== true, chromiumSandbox: true, viewport: {width:1280, height:900}, timeout:30000
  });
    context.on('close',()=>{context=undefined;page=undefined;cookieHandlersReady=false;});
  }
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(40000);
  if(!cookieHandlersReady) {
    const cookieAccept = page.locator('#onetrust-accept-btn-handler');
    await page.addLocatorHandler(cookieAccept,async()=>{await cookieAccept.click();});
    const emCookieAccept = page.getByText(/^(?:Accept\s*Cookies|接受\s*Cookies)$/i).first();
    await page.addLocatorHandler(emCookieAccept,async()=>{await emCookieAccept.click();});
    cookieHandlersReady=true;
  }
  stage = 'login';
  await page.goto(input.login_url, {waitUntil:'domcontentloaded'});
  const content = () => page.frameLocator('iframe#content');
  const dismissCookies = async () => {
    for (const frame of page.frames()) {
      const accept = frame.locator('#onetrust-accept-btn-handler');
      if (await accept.isVisible()) await accept.click();
      const nativeAccept = frame.getByText(/^(?:Accept\s*Cookies|接受\s*Cookies)$/i).first();
      if (await nativeAccept.isVisible()) await nativeAccept.click();
    }
  };
  await ensureEditorialManagerLogin(page, input, {dismissCookies, onStage: value => {stage = value;}});
  const collected = new Map();
  const collectRows = async (queueName = '') => {
    const rows = await readEditorialManagerTable(content(),queueName);
    for (const row of rows.filter(wanted)) {
      if (!row.number || !row.title_en || !row.raw_status) throw new Error('unrecognized_table');
      collected.set(row.number,row);
    }
  };
  const complete = () => input.tracked.every(paper=>[...collected.values()].some(row=>paper.number
    ? baseNumber(row.number) === baseNumber(paper.number) : key(row.title_en) === key(paper.title_en)));
  // A restored session can land directly on the freshly loaded author queue.
  stage = 'read';
  await content().locator('#datatable').waitFor({state:'visible',timeout:1200}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
  if(await content().locator('#datatable').isVisible()) await collectRows();
  if(!complete()) {
  stage = 'author';
  await dismissCookies();
  if (!await content().getByRole('heading', {name:'Author Main Menu', exact:true}).first().isVisible())
    await page.locator('#MainMenu').click();
  await content().getByRole('heading', {name:'Author Main Menu', exact:true}).first().waitFor({state:'visible'});
  const queueNames = ['Submissions Being Processed', 'Revisions Being Processed',
    'Submissions Needing Revision', 'Submissions with a Decision', 'Submissions with Production Completed'];
  const available = [];
  for (const name of queueNames) {
    if (await content().getByRole('link', {name, exact:true}).count()) available.push(name);
  }
  for (const name of available) {
    await content().getByRole('link', {name, exact:true}).click();
    await content().locator('#datatable').waitFor({state:'visible'});
    stage = 'read';
    await expandEditorialManagerPage(content());
    await collectRows(name);
    if (complete()) break;
    await page.locator('#MainMenu').click();
    await content().getByRole('heading', {name:'Author Main Menu', exact:true}).first().waitFor({state:'visible'});
  }
  }
  process.stdout.write(JSON.stringify({ok:true, rows:[...collected.values()]})+'\n');
} catch (error) {
  let code = stage === 'browser' ? 'browser_unavailable' : ['login','credentials','signed-in'].includes(stage) ? 'login_incomplete' : 'read_incomplete';
  if (['unsupported_journal','unrecognized_table'].includes(error.message)) code = error.message;
  if (page) {
    const diagnostic = {stage,error:error.name,title:await page.title().catch(()=> '')};
    if (/请稍候|Just a moment/i.test(diagnostic.title)) code = 'verification_required';
    await writeFile(input.profile_dir+'/last-read-error.json',JSON.stringify(diagnostic),{mode:0o600});
    for (const frame of page.frames()) {
      const password = frame.locator('input[type="password"]');
      if (await password.isVisible().catch(()=>false)) await password.fill('').catch(()=>{});
    }
    await page.screenshot({path:input.profile_dir+'/last-read-error.png'}).catch(()=>{});
  }
  process.stdout.write(JSON.stringify({ok:false,code})+'\n');
  if(!input.keep_browser) process.exitCode = 1;
} finally {
  input.password = '';
  if(context && !input.keep_browser) {await closeReaderContext(context).catch(()=>{});context=undefined;}
}

}
await runReader(read,async()=>{if(context)await closeReaderContext(context);context=undefined;});
