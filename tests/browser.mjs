import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = resolve(root, '.local');
const profile = resolve(artifact, 'chrome-qa-' + Date.now());
await mkdir(profile, { recursive: true });
const browserPath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chrome = spawn(browserPath, ['--headless=new','--disable-gpu','--in-process-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--remote-debugging-port=0','--user-data-dir=' + profile,'about:blank'], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
let chromeLog = ''; chrome.stderr.on('data', data => { chromeLog = (chromeLog + data).slice(-5000); });
let ws, nextId = 0;
const pending = new Map(), errors = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  for(let i=0; i<100; i++) { try { const value = await fn(); if(value) return value; } catch {} await pause(100); }
  throw new Error('Timed out: ' + label);
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve: data => {clearTimeout(timeout); resolve(data);}, reject: error => {clearTimeout(timeout); reject(error);} });
    ws.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true, userGesture:true});
  if(result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + JSON.stringify(result.exceptionDetails.exception));
  return result.result.value;
}
async function click(selector) { await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()'); }
async function waitLoaded() { await until(() => evaluate("document.querySelectorAll('.timer-row').length === 6"), 'six rows'); }
async function screenshot(name, width, height) {
  await cdp('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:width<680});
  await pause(250);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'horizontal overflow at ' + width);
  const result = await cdp('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
  await writeFile(resolve(artifact, name + '.png'), Buffer.from(result.data,'base64'));
}
try {
  const portText = await until(async () => await readFile(resolve(profile,'DevToolsActivePort'),'utf8'), 'Chrome debug port');
  const port = Number(portText.split('\n')[0]);
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = targets.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { ws.addEventListener('open',resolve,{once:true}); ws.addEventListener('error',reject,{once:true}); });
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if(data.id && pending.has(data.id)) {
      const task = pending.get(data.id); pending.delete(data.id);
      if(data.error) task.reject(new Error(JSON.stringify(data.error))); else task.resolve(data.result);
    }
    if(data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
  });
  console.log('Browser connection:', (await cdp('Browser.getVersion')).product); await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setTimezoneOverride', {timezoneId:'America/Los_Angeles'});
  await cdp('Emulation.setDeviceMetricsOverride', {width:1440,height:1150,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate', {url:'http://127.0.0.1:4173'});
  await waitLoaded();
  await until(() => evaluate("['connected','unconfigured','error'].includes(document.body.dataset.connection)"), 'shared connection state');
  const phase=await evaluate('document.body.dataset.connection');
  if(phase==='unconfigured') {
    assert.equal(await evaluate("document.querySelector('#edit-all').disabled"),true);
    assert.equal(await evaluate("document.querySelector('#import-settings').disabled"),true);
    assert.equal(await evaluate("document.querySelector('#next-countdown').textContent"),'--:--:--');
    assert.ok(await evaluate("document.querySelector('#shared-notice').textContent.includes('??? ??? ????')"));
  } else {
    assert.equal(phase,'connected','Configure Supabase before running the online browser check.');
    assert.equal(await evaluate("document.querySelector('#edit-all').disabled"),false);
    assert.notEqual(await evaluate("document.querySelector('#next-countdown').textContent"),'--:--:--');
    await click('[aria-label="Lv.40 ?? ??"]');
    assert.equal(await evaluate("document.querySelector('#edit-dialog').open"),true);
    await screenshot('settings',1440,1000);
    await click('#edit-dialog [data-close]');
  }
  await screenshot('desktop',1440,1180);
  await screenshot('mobile',390,844);
  await screenshot('mobile-small',320,740);
  await click('#help-button');
  assert.equal(await evaluate("document.querySelector('#help-dialog').open"),true);
  await click('#help-dialog [data-close]');
  assert.deepEqual(errors,[]);
  await writeFile(resolve(artifact,'browser-results.json'),JSON.stringify({ok:true,phase,checks:['6 bosses','honest shared-connection state','read-only editor inspection when connected','desktop/mobile/320px layout','help'],errors},null,2));
  console.log('PASS: read-only shared timer browser checks; screenshots in .local');
} catch (error) { console.error(chromeLog); throw error; } finally {
  if(ws && ws.readyState===1) { try { await cdp('Browser.close'); } catch {} ws.close(); }
  chrome.kill();
}
