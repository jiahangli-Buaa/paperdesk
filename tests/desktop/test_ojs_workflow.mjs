import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readOjs34Account} from '../../src/readers/ojs_workflow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.platform === 'darwin' ? 'macos-arm64' : 'windows-x64';
const runtime = process.env.PAPERDESK_TEST_RUNTIME || path.join(root, 'build/runtime', target);
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(runtime, 'browsers');
const {chromium} = await import(pathToFileURL(path.join(runtime, 'browser-module/playwright-core/index.mjs')).href);
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage();
  let authenticated = false, challenge = false, loginPosts = 0;
  const base = 'https://ojs.example.test/index.php/example';
  const row = (id, title, status, author = true, notice = '') => `<div class="listPanel__item--submission">
    <div class="listPanel__item--submission__id">${id}</div>
    <div class="listPanel__itemTitle">Example Author</div>
    <div class="listPanel__itemSubtitle">${title}</div>
    ${notice ? `<div class="listPanel__item--submission__notice">${notice}</div>` : ''}
    <button class="listPanel__item--submission__stage">${status}<span class="-screenReader">Currently in the ${status} stage.</span></button>
    <a href="${base}/${author ? 'authorDashboard/submission/' : 'workflow/index/'}${id}">View</a>
    <span>Last activity recorded on October 2, 2026.</span></div>`;
  await page.route('https://ojs.example.test/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      loginPosts++;
      const fields = new URLSearchParams(request.postData());
      authenticated = fields.get('username') === 'fixture' && fields.get('password') === 'synthetic-secret';
    }
    if (!authenticated) {
      return route.fulfill({contentType: 'text/html', body: `<form id="login" action="${base}/login/signIn" method="post">
        <input name="username"><input type="password" name="password">
        ${challenge ? '<div class="g-recaptcha">Human verification</div>' : ''}
        <button type="submit">Login</button></form>`});
    }
    return route.fulfill({contentType: 'text/html', body: `<button id="myQueue-button">My Queue</button>
      <div id="myQueue"><div class="listPanel--submissions">
        <div id="rows">${row(41, 'Earlier manuscript', 'Submission')}</div>
        <nav class="pkpPagination"><ul><li><button disabled>Previous</button></li>
          <li><button aria-current="true" id="page-number">1</button></li>
          <li><button id="next">Next</button></li></ul></nav>
      </div></div><script>
        document.getElementById('next').onclick = () => {
          document.getElementById('rows').innerHTML = ${JSON.stringify(row(42, 'Tracked manuscript', 'Review', true, 'Revisions requested') + row(43, 'Editorial assignment', 'Review', false))};
          document.getElementById('page-number').textContent = '2';
          document.getElementById('next').disabled = true;
        };
      </script>`});
  });
  const input = {login_url: base + '/login', login_method: 'password', username: 'fixture',
    password: 'synthetic-secret', tracked: [{number: '42', title_en: 'Tracked manuscript'}]};
  assert.deepEqual(await readOjs34Account(page, input), [{number: '42', title_en: 'Tracked manuscript',
    raw_status: 'Revisions requested', submitted_at: '', status_date: ''}]);
  assert.equal(input.password, '');
  assert.equal(loginPosts, 1);
  authenticated = false; challenge = true;
  await assert.rejects(readOjs34Account(page, {...input, password: 'synthetic-secret'}), /verification_required/);
  assert.equal(loginPosts, 1);
  console.log('OJS login, pagination, author-only matching and manual verification handoff passed.');
} finally {
  await browser.close();
}
