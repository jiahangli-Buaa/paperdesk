import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const module=new URL('../../src/readers/reader_worker.mjs',import.meta.url).href;
const script=`import {runReader} from ${JSON.stringify(module)};await runReader(async input=>{process.stdout.write('started\\n');await new Promise(r=>setTimeout(r,input.delay));process.stdout.write('result\\n');},async()=>{process.stdout.write('closed\\n');});`;
function child(){const process=spawn(globalThis.process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','inherit']});let output='';process.stdout.on('data',chunk=>{output+=chunk;});return {process,output:()=>output};}
const single=child();single.process.stdin.end(JSON.stringify({delay:10})+'\n');await once(single.process,'exit');
assert.match(single.output(),/started\nresult\nclosed\n/,'One-shot input must finish its read after stdin EOF');
const persistent=child();persistent.process.stdin.write(JSON.stringify({keep_browser:true,delay:30000})+'\n');
await once(persistent.process.stdout,'data');const start=Date.now();persistent.process.stdin.end();await once(persistent.process,'exit');
assert.ok(Date.now()-start<3000);assert.match(persistent.output(),/closed/);assert.doesNotMatch(persistent.output(),/result/);
console.log('One-shot reads and cancellation of persistent reads passed.');
