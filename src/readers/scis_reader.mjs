// Application connector: only reads the signed-in author's manuscript tables.
// Login credentials arrive on stdin and are never written to logs or files.
import {mkdir, chmod, writeFile} from 'node:fs/promises';
import {openReaderContext,closeReaderContext} from './reader_context.mjs';
import {isScholarOneUrl} from './portal_urls.mjs';

import {runReader} from './reader_worker.mjs';
let context, page, cookieHandlersReady=false;
async function read(input) {
const key = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const baseNumber = value => String(value || '').replace(/\.R\d+$/i, '');
const wanted = row => input.tracked.some(paper => paper.number
  ? baseNumber(paper.number) === baseNumber(row.number) : key(paper.title_en) === key(row.title_en));
let stage = 'browser';
let loginMessage = '';

try {
  if (!isScholarOneUrl(input.login_url)) {
    throw new Error('unsupported_journal');
  }
  const useFirefox = input.browser_engine === 'firefox';
  await mkdir(input.profile_dir, {recursive: true, mode: 0o700});
  if(process.platform!=='win32') await chmod(input.profile_dir, 0o700);
  if(!context) {
    context=await openReaderContext(input, {
    ...(useFirefox ? {} : {chromiumSandbox:true}),
    headless: input.interactive !== true,
    viewport: {width: 1280, height: 900},
    timeout: 30000
  });
    context.on('close',()=>{context=undefined;page=undefined;cookieHandlersReady=false;});
  }
  page = context.pages()[0] || await context.newPage();
  page.removeAllListeners('dialog');
  page.on('dialog',async dialog=>{
    loginMessage=dialog.message();
    await dialog.dismiss();
  });
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(40000);
  stage = 'login';
  await page.goto(input.login_url, {waitUntil: 'domcontentloaded'});
  const rejectCookies = page.locator('#onetrust-reject-all-handler');
  if(!cookieHandlersReady) {await page.addLocatorHandler(rejectCookies,async()=>{await rejectCookies.click();});cookieHandlersReady=true;}
  if (await rejectCookies.isVisible()) await rejectCookies.click();
  const authorLink = () => page.locator('a').filter({hasText: /^\s*Author\s*$/});
  await Promise.race([
    page.locator('#USERID').waitFor({state: 'visible', timeout: input.interactive ? 120000 : 30000}),
    authorLink().first().waitFor({state: 'visible', timeout: input.interactive ? 120000 : 30000})
  ]);
  if (await page.locator('#USERID').isVisible()) {
    stage = 'credentials';
    await page.locator('#USERID').fill(input.username);
    await page.locator('#PASSWORD').fill(input.password);
    input.password = '';
    await page.locator('#logInButton').click();
    stage = 'signed-in';
    await authorLink().first().waitFor({state: 'visible', timeout: input.interactive ? 120000 : 30000});
  }
  input.password = '';
  if (await rejectCookies.isVisible()) await rejectCookies.click();
  stage = 'author';
  await authorLink().first().click();
  await page.locator('#authorDashboardQueue').waitFor({state: 'visible'});
  const collected = new Map();
  const queues = ['Submitted Manuscripts', 'Manuscripts with Decisions', 'Manuscripts I Have Co-Authored'];
  for (const queue of queues) {
    // The site can remember a different queue from the previous session.
    const link = page.getByRole('link', {name: queue, exact: false});
    if (!await link.count()) continue;
    await link.first().click();
    await page.getByRole('heading', {name: queue, exact: true}).waitFor({state: 'visible'});
    await page.locator('#authorDashboardQueue').waitFor({state: 'visible'});
    stage = 'read';
    const pageSize = page.locator('select[name="authorDashboardQueue_length"]').first();
    await page.locator('#authorDashboardQueue_wrapper').waitFor({state:'visible'});
    await page.locator('#authorDashboardQueue_processing').waitFor({state:'hidden'});
    if (await pageSize.isVisible()) await pageSize.selectOption('50');
    while (true) {
    const rows = await page.locator('#authorDashboardQueue').evaluate(table =>
      [...table.querySelectorAll(':scope > tbody > tr[id^="queue_"]')].map(row => {
        const cell = name => [...row.children].find(td => td.getAttribute('data-label')?.toLowerCase() === name);
        const titleParts = [];
        for (const node of cell('title')?.childNodes || []) {
          if (node.nodeName === 'BR' || node.nodeName === 'A' || node.nodeName === 'BUTTON') break;
          titleParts.push(node.textContent);
        }
        return {
          number: (cell('id')?.textContent || '').replace(/\s*\(REX-[^)]*\)/g, '').trim(),
          title_en: titleParts.join('').trim().replace(/\s+/g, ' '),
          raw_status: [...(cell('status')?.querySelectorAll('.pagecontents') || [])].map(e => e.textContent.trim()).filter(Boolean).join(' · '),
          submitted_at: cell('submitted')?.textContent.trim() || ''
        };
      })
    );
    for (const row of rows.filter(wanted)) {
      if (!row.number || !row.title_en || !row.raw_status) throw new Error('unrecognized_table');
      collected.set(row.number, row);
    }
    const next = page.locator('#authorDashboardQueue_next');
    if (!await next.isVisible() || /disabled/.test(await next.getAttribute('class') || '')) break;
    await next.click();
    }
    const found = [...collected.values()];
    if (input.tracked.every(paper => found.some(row => paper.number
      ? baseNumber(row.number) === baseNumber(paper.number) : key(row.title_en) === key(paper.title_en)))) break;
  }
  process.stdout.write(JSON.stringify({ok: true, rows: [...collected.values()]})+'\n');
} catch (error) {
  let code = ['login','credentials','signed-in'].includes(stage) ? 'login_incomplete' : stage === 'browser' ? 'browser_unavailable' : 'read_incomplete';
  if (['unsupported_journal', 'unrecognized_table'].includes(error.message)) code = error.message;
  if (page) {
    if (await page.getByText(/Incorrect User ID or Password/i).first().isVisible().catch(() => false)) {
      loginMessage = 'Incorrect User ID or Password';
    }
    const diagnostic = {stage, error: error.name, title: await page.title().catch(() => ''),login_message:loginMessage};
    if(/password|user.?id|username/i.test(loginMessage) && /incorrect|invalid|not match/i.test(loginMessage)) code='credentials_rejected';
    if(/locked|disabled|suspend/i.test(loginMessage)) code='account_unavailable';
    if (/请稍候|Just a moment/i.test(diagnostic.title)) code = 'verification_required';
    await writeFile(input.profile_dir + '/last-read-error.json', JSON.stringify(diagnostic), {mode:0o600});
    // Hide any credentials before keeping a local failure preview for troubleshooting.
    if (await page.locator('#PASSWORD').isVisible()) await page.locator('#PASSWORD').fill('').catch(() => {});
    await page.screenshot({path: input.profile_dir + '/last-read-error.png'}).catch(() => {});
  }
  process.stdout.write(JSON.stringify({ok: false, code})+'\n');
  if(!input.keep_browser) process.exitCode = 1;
} finally {
  input.password = '';
  if(context && !input.keep_browser) {await closeReaderContext(context).catch(()=>{});context=undefined;}
}

}
await runReader(read,async()=>{if(context)await closeReaderContext(context);context=undefined;});
