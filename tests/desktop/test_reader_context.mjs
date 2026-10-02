import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openReaderContext,closeReaderContext} from '../../src/readers/reader_context.mjs';
const root=await mkdtemp(join(tmpdir(),'paperdesk-context-'));
try {
 const modulePath=join(root,'fake-browser.mjs');
 await writeFile(modulePath,`export const firefox={async launchPersistentContext(profile,options){return {profile,options,closed:false,async close(){this.closed=true;},async clearCookies(){this.cookiesCleared=true;},async addInitScript(){this.storageReset=true;}};}}; export const chromium=firefox;`);
 const input=name=>({browser_module:modulePath,browser_engine:'firefox',profile_dir:join(root,name)});
 const a=await openReaderContext(input('author-a'),{headless:true});
 const b=await openReaderContext(input('author-b'),{headless:true});
 assert.notEqual(a.profile,b.profile);
 await closeReaderContext(a);
 assert.equal(b.closed,false,'Account browser lifetimes are independent');
 const reset=await openReaderContext({...input('changed-author'),reset_session:true},{headless:false});
 assert.ok(reset.cookiesCleared&&reset.storageReset,'Changed account identity clears the old login');
 assert.equal(reset.options.headless,false,'Manual verification remains visible');
 await Promise.all([b,reset].map(closeReaderContext));
 console.log('PASS: per-account profiles, independent lifetime, changed identity, visible verification');
}finally{await rm(root,{recursive:true,force:true});}
