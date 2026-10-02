import {ojs34Entry} from './portal_urls.mjs';
import {readOjs34List} from './ojs_rows.mjs';

const key = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const matches = (paper, row) => paper.number ? key(paper.number) === key(row.number)
  : key(paper.title_en) === key(row.title_en);

export async function readOjs34Account(page, input) {
  const entry = ojs34Entry(input.login_url);
  if (!entry || input.login_method !== 'password') throw new Error('unsupported_journal');
  try {
    await page.goto(entry.submissions, {waitUntil: 'domcontentloaded'});
  } catch {
    throw new Error('site_unavailable');
  }
  const queue = page.locator('#myQueue .listPanel--submissions');
  const username = page.locator('form#login input[name="username"]');
  await Promise.race([
    queue.waitFor({state: 'visible', timeout: 20000}),
    username.waitFor({state: 'visible', timeout: 20000})
  ]);
  if (!await queue.isVisible()) {
    await username.fill(input.username);
    await page.locator('form#login input[name="password"]').fill(input.password);
    input.password = '';
    const challenge = page.locator('form#login .g-recaptcha, form#login altcha-widget');
    if (await challenge.count()) {
      if (!input.interactive) throw new Error('verification_required');
      // The user completes the challenge and presses Login in the visible window.
    } else {
      await page.locator('form#login button[type="submit"]').click();
    }
    try {
      await queue.waitFor({state: 'visible', timeout: input.interactive ? 240000 : 45000});
    } catch {
      throw new Error('login_incomplete');
    }
  }
  input.password = '';
  if (input.connect_only) return [];
  const collected = new Map();
  const complete = () => input.tracked.every(paper => [...collected.values()].some(row => matches(paper, row)));
  // These are the author's queues. Editorial-only assignments are excluded by the parser.
  for (const name of ['myQueue', 'archive']) {
    const tab = page.locator('#' + name + '-button');
    if (!await tab.count()) continue;
    await tab.click();
    const scope = page.locator('#' + name);
    await scope.locator('.listPanel--submissions').waitFor({state: 'visible'});
    const seen = new Set();
    while (true) {
      await scope.locator('.pkpSpinner').first().waitFor({state: 'hidden'});
      const result = await readOjs34List(scope);
      if (!result.recognized) throw new Error('unrecognized_table');
      for (const row of result.rows) {
        if (input.tracked.some(paper => matches(paper, row))) collected.set(row.number, row);
      }
      if (complete()) return [...collected.values()];
      const next = scope.locator('.pkpPagination li:last-child button');
      if (!await next.count() || !await next.isEnabled()) break;
      const marker = await scope.locator('.pkpPagination [aria-current="true"]').textContent();
      if (seen.has(marker)) throw new Error('read_incomplete');
      seen.add(marker);
      await next.click();
      await scope.locator('.pkpPagination__loading').waitFor({state: 'hidden'});
    }
  }
  return [...collected.values()];
}
