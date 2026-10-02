// Credentials are received for one read at a time; EOF closes the account's browser.
import {createInterface} from 'node:readline';
export async function runReader(read, close) {
  let closing = false, persistent = false, ended = false;
  async function stop() {
    if(closing)return;
    closing=true;
    await close().catch(()=>{});
    process.exit(0);
  }
  process.on('SIGTERM',stop);
  process.on('SIGINT',stop);
  try {
    const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
    lines.on('close',()=>{ended=true;if(persistent)stop();});
    for await(let line of lines) {
      const input=JSON.parse(line);
      persistent=Boolean(input.keep_browser);
      if(persistent&&ended){await stop();break;}
      line='';
      await read(input);
    }
  } finally {await close().catch(()=>{});}
}
