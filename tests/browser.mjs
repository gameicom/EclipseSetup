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
async function getState() { return evaluate("JSON.parse(localStorage.getItem('eclipse-boss-timer.v1'))"); }
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
  const original = await getState();
  assert.equal(original.bosses[4].anchor_kst,'2026-10-22T18:15:00');
  assert.equal(await evaluate("document.querySelector('[data-level=\"75\"] .anchor-value').textContent.includes('18:15:00')"),true);
  await screenshot('desktop',1440,1180);
  await click('[aria-label="Lv.40 시간 설정"]');
  assert.equal(await evaluate("document.querySelector('#edit-dialog').open"),true);
  await evaluate("document.querySelector('[name=\"hours\"]').value='0';document.querySelector('#edit-form').requestSubmit()");
  assert.equal(await evaluate("document.querySelector('#edit-dialog').open"),true);
  assert.ok(await evaluate("document.querySelector('#edit-error').textContent.length > 0"));
  await evaluate("document.querySelector('[name=\"hours\"]').value='9';document.querySelector('[name=\"minutes\"]').value='5';document.querySelector('#edit-form').requestSubmit()");
  assert.equal((await getState()).bosses[0].interval_seconds,32700);
  await cdp('Page.reload');
  await waitLoaded();
  assert.equal((await getState()).bosses[0].interval_seconds,32700);
  await click('[aria-label="Lv.50 초기화"]');
  let reset = await getState();
  assert.notEqual(reset.bosses[1].anchor_kst,original.bosses[1].anchor_kst);
  await click('#undo');
  assert.equal((await getState()).bosses[1].anchor_kst,original.bosses[1].anchor_kst);
  await click('#reset-all');
  await click('#confirm-dialog [data-close]');
  assert.equal((await getState()).bosses[1].anchor_kst,original.bosses[1].anchor_kst);
  await click('#reset-all'); await click('#confirm-reset');
  reset = await getState();
  assert.equal(new Set(reset.bosses.map(b=>b.anchor_kst)).size,1);
  await click('#undo');
  assert.equal((await getState()).bosses[1].anchor_kst,original.bosses[1].anchor_kst);
  await click('[data-sort="next"]');
  const sorted = await evaluate("[...document.querySelectorAll('.timer-row .next-value')].map(t=>Date.parse(t.dateTime))");
  assert.deepEqual(sorted,[...sorted].sort((a,b)=>a-b));
  await click('#sound-toggle');
  await until(async () => (await getState()).sound, 'sound enabled');
  await click('#test-sound');
  assert.equal(await evaluate("document.querySelector('#audio-note').classList.contains('needs-activation')"),false);
  await click('#sound-toggle');
  await click('#edit-all');
  assert.equal(await evaluate("document.querySelectorAll('#edit-fields fieldset').length"),6);
  await screenshot('settings',1440,1000);
  await click('#edit-dialog [data-close]');
  await screenshot('mobile',390,844);
  await screenshot('mobile-small',320,740);
  await click('[aria-label="Lv.75 시간 설정"]');
  await screenshot('mobile-settings',390,844);
  await click('#edit-dialog [data-close]');
  await click('#help-button');
  assert.equal(await evaluate("document.querySelector('#help-dialog').open"),true);
  await click('#help-dialog [data-close]');
  // Invalid persisted data is preserved until an intentional edit.
  await evaluate("localStorage.setItem('eclipse-boss-timer.v1', '{broken')");
  await cdp('Page.reload'); await waitLoaded();
  assert.equal(await evaluate("document.querySelector('#storage-warning').hidden"),false);
  assert.equal(await evaluate("localStorage.getItem('eclipse-boss-timer.v1')"),'{broken');
  // Restore the desktop preset in this isolated QA profile.
  await evaluate("localStorage.setItem('eclipse-boss-timer.v1'," + JSON.stringify(JSON.stringify(original)) + ")");
  await cdp('Page.reload'); await waitLoaded();
  assert.deepEqual(errors,[]);
  await writeFile(resolve(artifact,'browser-results.json'),JSON.stringify({ok:true,checks:['6 bosses','desktop settings migration','KST on US browser','edit validation','save and reload','single reset/undo','all reset/cancel/undo','sort','audio activation','6-row editor','desktop/mobile/320px layout','help','corrupt storage preservation'],errors},null,2));
  console.log('PASS: browser behavior and responsive layouts; screenshots in .local');
} catch (error) { console.error(chromeLog); throw error; } finally {
  if(ws && ws.readyState===1) { try { await cdp('Browser.close'); } catch {} ws.close(); }
  chrome.kill();
}
