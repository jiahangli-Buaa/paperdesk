import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openReaderContext, closeReaderContext} from '../../src/readers/reader_context.mjs';
import {ensureEditorialManagerLogin} from '../../src/readers/editorial_manager_login.mjs';
import {readEditorialManagerTable} from '../../src/readers/editorial_manager_rows.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.platform === 'darwin' ? 'macos-arm64' : 'windows-x64';
const runtime = process.env.PAPERDESK_TEST_RUNTIME || path.join(root, 'build/runtime', target);
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(runtime, 'browsers');
const profile = await mkdtemp(path.join(os.tmpdir(), 'paperdesk-em-login-'));
const input = {profile_dir: profile, browser_engine: 'chromium',
  browser_module: path.join(runtime, 'browser-module/playwright-core/index.mjs'),
  username: 'fixture-author', password: '', interactive: false};
const base = 'https://www.editorialmanager.com/fixture/';
let context, loginPosts = 0, mode = 'frame-form', restoreQueue = false;
const open = async () => {
  context = await openReaderContext(input, {headless: true});
  await context.route(base + '**', async route => {
    const request = route.request(), url = new URL(request.url());
    let authenticated = /fixture-session=valid/.test(request.headers().cookie || '');
    const headers = {'content-type': 'text/html'};
    if (request.method() === 'POST') {
      loginPosts++;
      const fields = new URLSearchParams(request.postData());
      assert.equal(fields.get('username'), input.username);
      assert.equal(fields.get('password'), 'synthetic-secret');
      authenticated = true;
      headers['set-cookie'] = 'fixture-session=valid; Max-Age=3600; Path=/; Secure; HttpOnly';
    }
    let body;
    if (authenticated) body = restoreQueue ? `<table id="datatable"><thead><tr>
      <th>Manuscript Number</th><th>Title</th><th>Initial Date Submitted</th><th>Current Status</th>
      </tr></thead><tbody><tr><td>TEST-001</td><td>Fixture manuscript</td><td>02 Oct 2026</td><td>Under Review</td></tr></tbody></table>`
      : '<h1>Author Main Menu</h1><a href="#">Submissions Being Processed</a>';
    else if (mode === 'landing' && !url.pathname.endsWith('/login')) body = `<a href="${base}login">Login</a>`;
    else if (mode === 'frame-form' && !url.pathname.endsWith('/login')) body = `<iframe id="content" src="${base}login"></iframe>`;
    else body = `<form method="post" action="${base}login"><input name="username"><input type="password" name="password"><button>Author Login</button></form>`;
    await route.fulfill({headers, body});
  });
  return context.pages()[0] || await context.newPage();
};
const login = async page => {
  input.password = 'synthetic-secret';
  await page.goto(base);
  await ensureEditorialManagerLogin(page, input, {timeout: 5000});
  assert.equal(input.password, '');
};
try {
  let page = await open();
  await login(page);
  assert.equal(loginPosts, 1); // Embedded form with no top-level Login link or logout selector.
  await closeReaderContext(context); context = undefined;
  restoreQueue = true;
  page = await open();
  await login(page);
  assert.equal(loginPosts, 1); // Persisted cookie survives an actual browser restart.
  assert.equal((await readEditorialManagerTable(page))[0].number, 'TEST-001');
  await context.clearCookies();
  mode = 'landing'; restoreQueue = false;
  await login(page);
  assert.equal(loginPosts, 2); // Expired session opens the landing page's Login link.
  await context.clearCookies(); mode = 'top-form';
  await login(page);
  assert.equal(loginPosts, 3); // Direct login form also works without a navigation link.
  console.log('EM framed/direct login, Login navigation, browser restart and expired-session recovery passed.');
} finally {
  if (context) await closeReaderContext(context);
  await rm(profile, {recursive: true, force: true});
}
