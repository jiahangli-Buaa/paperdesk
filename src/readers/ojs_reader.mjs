import {openReaderContext, closeReaderContext} from './reader_context.mjs';
import {readOjs34Account} from './ojs_workflow.mjs';
import {runReader} from './reader_worker.mjs';

let context;
async function read(input) {
  try {
    if (!context) {
      context = await openReaderContext(input, {headless: !input.interactive,
        viewport: {width: 1280, height: 900}, timeout: 30000});
      context.on('close', () => { context = undefined; });
    }
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(40000);
    const rows = await readOjs34Account(page, input);
    process.stdout.write(JSON.stringify({ok: true, rows}) + '\n');
  } catch (error) {
    const codes = ['unsupported_journal', 'site_unavailable', 'verification_required',
      'login_incomplete', 'unrecognized_table', 'read_incomplete'];
    const code = codes.includes(error.message) ? error.message : context ? 'read_incomplete' : 'browser_unavailable';
    process.stdout.write(JSON.stringify({ok: false, code}) + '\n');
    if (!input.keep_browser) process.exitCode = 1;
  } finally {
    input.password = '';
    if (context && !input.keep_browser) await closeReaderContext(context).catch(() => {});
  }
}
await runReader(read, async () => { if (context) await closeReaderContext(context); context = undefined; });
