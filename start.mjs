import { spawn } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const url = 'http://127.0.0.1:' + (process.env.PORT || 4173);
const root = fileURLToPath(new URL('./',import.meta.url));
async function isRunning() {
  let response;
  try { response = await fetch(url, {signal: AbortSignal.timeout(1200)}); }
  catch { return false; }
  const html = await response.text();
  if (!response.ok || !html.includes('id="boss-rows"')) throw new Error('This port is used by another app. Set PORT to a different number.');
  return true;
}
try {
  if (!await isRunning()) {
    await mkdir(new URL('./.local/',import.meta.url),{recursive:true});
    const output = await open(new URL('./.local/server.log',import.meta.url),'a');
    const child = spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',output.fd,output.fd]});
    child.on('error',error=>console.error(error.message));
    child.unref();
    await output.close();
    if(child.pid) await writeFile(new URL('./.local/server.pid',import.meta.url),String(child.pid));
    let ready = false;
    for(let attempt=0;attempt<30;attempt++) {
      if(await isRunning()) {ready=true;break;}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!ready) throw new Error('Server failed to start. See .local/server.log.');
  }
  console.log('Eclipse Boss Timer: ' + url);
  if(!process.argv.includes('--no-browser')) {
    const opener = spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{detached:true,windowsHide:true,stdio:'ignore'});
    opener.on('error',()=>console.log('Open the address above in your browser.'));
    opener.unref();
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
