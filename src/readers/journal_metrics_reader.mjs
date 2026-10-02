// Read public journal metrics through the site's ordinary search and detail pages.
import {mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
let text = '';
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9\u3400-\u9fff]/g,'');
let context;
const results = [];
try {
  const {chromium} = await import(pathToFileURL(input.browser_module).href);
  await mkdir(input.profile_dir,{recursive:true,mode:0o700});
  context = await chromium.launchPersistentContext(input.profile_dir, {
    
    headless:true,chromiumSandbox:true,viewport:{width:1280,height:900},timeout:30000
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  for (const journal of input.journals) {
    try {
      let url = journal.lookup_url;
      if (!url || !/^https:\/\/www\.scholay\.com\/journal\/\d+(\/|$)/.test(url)) {
        await page.goto('https://www.scholay.com/journals/search?q='+encodeURIComponent(journal.name),{waitUntil:'domcontentloaded'});
        await page.getByRole('heading',{name:/^关键词/}).waitFor({state:'visible'});
        const links = await page.locator('h3 a[href^="/journal/"]').evaluateAll(anchors=>anchors.map(a=>({name:a.textContent.trim(),url:a.href})));
        const exact = links.filter(link=>normalize(link.name)===normalize(journal.name));
        if (exact.length !== 1) throw new Error(exact.length ? 'ambiguous' : 'not_found');
        url = exact[0].url;
      }
      await page.goto(url,{waitUntil:'domcontentloaded'});
      await page.getByRole('heading',{name:'全部指标',exact:true}).waitFor({state:'visible'});
      const result = await page.evaluate(()=>({
        name:document.querySelector('h1')?.textContent.trim(),
        issns:[...document.querySelectorAll('a[href*="portal.issn.org/resource/ISSN/"]')].map(a=>a.href.split('/').pop()),
        groups:[...document.querySelectorAll('dl')].map(dl=>({
          label:dl.previousElementSibling?.textContent.trim(),
          fields:Object.fromEntries([...dl.querySelectorAll('dt')].map(dt=>[dt.textContent.trim(),dt.nextElementSibling?.textContent.trim()]))
        }))
      }));
      if (normalize(result.name)!==normalize(journal.name)) throw new Error('name_mismatch');
      results.push({id:journal.id,ok:true,source_url:page.url(),...result});
    } catch (error) {
      results.push({id:journal.id,ok:false,code:['ambiguous','not_found','name_mismatch'].includes(error.message)?error.message:'unavailable'});
    }
  }
  process.stdout.write(JSON.stringify({ok:true,results}));
} catch {
  process.stdout.write(JSON.stringify({ok:false,code:'browser_unavailable'}));
  process.exitCode=1;
} finally {
  if (context) await context.close().catch(()=>{});
}
