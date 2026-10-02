// Editorial Manager author queues using the journal's ORCID login option.
import {mkdir, chmod, readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {submitOrcidCredentials} from './orcid_login.mjs';
import {isEditorialManagerUrl} from './portal_urls.mjs';
import {readEditorialManagerTable,expandEditorialManagerPage} from './editorial_manager_rows.mjs';

let requestText = '';
for await (const chunk of process.stdin) requestText += chunk;
const input = JSON.parse(requestText);
requestText = '';
const key = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const baseNumber = value => String(value || '').replace(/(?:\.R|R)\d+$/i, '');
const wanted = row => input.tracked.some(paper => paper.number
  ? baseNumber(paper.number) === baseNumber(row.number) : key(paper.title_en) === key(row.title_en));
let context, page, stage = 'browser';

try {
  if (!isEditorialManagerUrl(input.login_url) ||
      input.login_method !== 'orcid') throw new Error('unsupported_journal');
  const {firefox} = await import(pathToFileURL(input.browser_module).href);
  await mkdir(input.profile_dir, {recursive:true, mode:0o700});
  if(process.platform!=='win32') await chmod(input.profile_dir, 0o700);
  context = await firefox.launchPersistentContext(input.profile_dir, {
    headless:input.interactive !== true, viewport:{width:1280,height:900}, timeout:30000
  });
  // Preserve session cookies across browser restarts. Passwords remain in the keychain.
  const sessionFile = input.profile_dir + '/session-state.json';
  let savedSession = false;
  try {
    const state = JSON.parse(await readFile(sessionFile, 'utf8'));
    if (state.cookies?.length) { await context.addCookies(state.cookies); savedSession = true; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(40000);
  stage = 'login';
  await page.goto(input.login_url, {waitUntil:'load'});
  const content = () => page.frameLocator('iframe#content');
  const logout = page.locator('#logoutLink');
  await Promise.race([
    logout.waitFor({state:'visible'}),
    page.getByRole('link', {name:'Login',exact:true}).waitFor({state:'visible'})
  ]);
  const accept = page.locator('#onetrust-accept-btn-handler');
  await accept.waitFor({state:'visible',timeout:5000}).catch(error=>{if(error.name!=='TimeoutError')throw error;});
  if(await accept.isVisible()) { await accept.click(); await accept.waitFor({state:'hidden'}); }
  if(!await logout.isVisible()) {
    if(!input.interactive && !savedSession && !input.password) throw new Error('sso_login_required');
    const login = content().frameLocator('iframe[name="login"]');
    const orcidLink = login.getByRole('link', {name:'Login using ORCID',exact:true});
    if (!await orcidLink.count()) throw new Error('orcid_login_unavailable');
    await orcidLink.click();
    stage = 'orcid';
    const deadline = Date.now() + (input.interactive ? 240000 : 60000);
    let submittedCredentials = false;
    while(Date.now() < deadline && !await logout.isVisible()) {
      const auth = context.pages().find(candidate=>!candidate.isClosed() && new URL(candidate.url()).origin==='https://orcid.org');
      if(auth && !submittedCredentials && await auth.locator('#username-input').isVisible()) {
        if(input.password) {
          await submitOrcidCredentials(auth,input.username,input.password);
          input.password = '';
          submittedCredentials = true;
        } else if(!input.interactive) throw new Error('sso_login_required');
      }
      await page.waitForTimeout(300);
    }
    // Verification codes and new OAuth grants are completed only in an explicitly opened window.
    if(!await logout.isVisible()) throw new Error(submittedCredentials ? 'orcid_login_incomplete' : 'orcid_authorization_required');
  }
  input.password = '';
  stage = 'author';
  await page.locator('#MainMenu').click();
  await content().getByRole('heading',{name:'Author Main Menu',exact:true}).first().waitFor({state:'visible'});
  await writeFile(sessionFile, JSON.stringify(await context.storageState()), {mode:0o600});
  if(process.platform!=='win32') await chmod(sessionFile, 0o600);
  const collected = new Map();
  if(!input.connect_only) {
    const queueNames = ['Submissions Needing Revision','Incomplete Revisions',
      'Revisions Being Processed','Submissions Being Processed','Submissions with a Decision',
      'Submissions with Production Completed'];
    const available = [];
    for(const name of queueNames) {
      if(await content().getByRole('link',{name,exact:true}).count()) available.push(name);
    }
    for(const name of available) {
      await content().getByRole('link',{name,exact:true}).click();
      await content().locator('#datatable').waitFor({state:'visible'});
      stage = 'read';
      await expandEditorialManagerPage(content());
      const rows = await readEditorialManagerTable(content(),name);
      for(const row of rows.filter(wanted)) {
        if(!row.number || !row.title_en || !row.raw_status) throw new Error('unrecognized_table');
        collected.set(row.number,row);
      }
      if(input.tracked.every(paper=>[...collected.values()].some(row=>paper.number
        ? baseNumber(paper.number) === baseNumber(row.number) : key(row.title_en) === key(paper.title_en)))) break;
      await page.locator('#MainMenu').click();
      await content().getByRole('heading',{name:'Author Main Menu',exact:true}).first().waitFor({state:'visible'});
    }
  }
  process.stdout.write(JSON.stringify({ok:true,rows:[...collected.values()]}));
} catch(error) {
  let code = stage === 'browser' ? 'browser_unavailable' : ['login','orcid'].includes(stage) ? 'sso_login_required' : 'read_incomplete';
  if(['unsupported_journal','unrecognized_table','sso_login_required','orcid_login_incomplete','orcid_authorization_required','orcid_login_unavailable'].includes(error.message)) code = error.message;
  if(page) {
    const diagnostic = {stage,error:error.name,title:await page.title().catch(()=> '')};
    if(['author','read'].includes(stage)) {
      diagnostic.message=String(error.message).split('\n')[0];
      diagnostic.frames=[];
      for(const frame of page.frames()) {
        diagnostic.frames.push(await frame.evaluate(()=>({
          path:location.origin+location.pathname,
          frames:[...document.querySelectorAll('iframe')].map(e=>({id:e.id,name:e.name})),
          headings:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.textContent.trim()),
          links:[...document.querySelectorAll('a')].filter(e=>e.getClientRects().length).map(e=>({id:e.id,text:e.textContent.trim()})),
          tables:[...document.querySelectorAll('table')].map(e=>({id:e.id,headings:[...e.rows[0]?.cells||[]].map(c=>c.textContent.trim())}))
        })).catch(()=>({detached:true})));
      }
      await page.screenshot({path:input.profile_dir+'/last-read-error.png'}).catch(()=>{});
    }
    if(/请稍候|Just a moment/i.test(diagnostic.title)) code = 'verification_required';
    await writeFile(input.profile_dir+'/last-read-error.json',JSON.stringify(diagnostic),{mode:0o600}).catch(()=>{});
  }
  process.stdout.write(JSON.stringify({ok:false,code}));
  process.exitCode = 1;
} finally {
  input.password = '';
  if(context) await context.close().catch(()=>{});
}
