import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {PGlite} from '@electric-sql/pglite';
import {defaultSettings,kstISO} from '../dist/core.js';
import {defaultNamedSettings} from '../dist/named.js';
const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const db=new PGlite(),realNow=Date.now,realSetTimeout=setTimeout;
let instance=0;
before(async()=>{
 await db.exec('create role anon;create role authenticated;');
 for(const file of ['setup.sql','named.sql']) await db.exec(await readFile(new URL('../supabase/'+file,import.meta.url),'utf8'));
});
after(()=>db.close());
async function fixture({missingNamed=false}={}) {
 let now=realNow();
 const dom=new JSDOM(html,{url:'https://timer.test/',pretendToBeVisual:true}),window=dom.window,document=window.document;
 const $=id=>document.getElementById(id),saved=new Map(),intervals=new Map(),timeouts=new Set(),channels=[],calls=[],errors=[];
 const field=defaultSettings().bosses.map((b,i)=>({...b,anchor_kst:kstISO(now+(i+1)*3600000)}));
 const named=defaultNamedSettings(now).bosses;
 await db.exec('reset role;');
 for(const [table,bosses] of [['eclipse_timer_state',field],['eclipse_named_timer_state',named]])
  await db.query('update public.'+table+' set bosses=$1,revision=0,client_id=null where id=1',[JSON.stringify(bosses)]);
 await db.exec('set role anon;');
 const run=(name,args=[])=>db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as value',args).then(r=>r.rows[0].value);
 const emit=(group,snapshot)=>{for(const channel of channels)if(!channel.closed&&channel.filter.table===(group==='named'?'eclipse_named_timer_state':'eclipse_timer_state'))channel.callback({new:snapshot});};
 const client={
  channel(name){const channel={name,closed:false,on(_type,filter,callback){Object.assign(channel,{filter,callback});return channel;},
   subscribe(status){channel.status=status;queueMicrotask(()=>status('SUBSCRIBED'));return channel;}};
   channels.push(channel);return channel;
  },
  async removeChannel(channel){channel.closed=true;},
  async rpc(name,args) {
   calls.push({name,args});
   if(missingNamed&&name==='eclipse_read_named_timers')return{data:null,error:{code:'PGRST202'}};
   try {
    const data=await run(name,args?[args.p_bosses,args.p_base,args.p_levels,args.p_action,args.p_client_id].map((v,i)=>i<2?JSON.stringify(v):v):[]);
    data.server_now=new Date(now).toISOString();
    if(args&&data.status==='ok')emit(name.includes('named')?'named':'field',data.snapshot);
    return{data,error:null};
   }catch(error){return{data:null,error:{message:error.message}};}
  }
 };
 function setGlobal(key,value){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
 for(const [key,value] of Object.entries({window,document,localStorage:window.localStorage,navigator:window.navigator,isSecureContext:false,supabase:{createClient:()=>client},
  setInterval:(fn,ms)=>{const id=Symbol();intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),
  setTimeout:(fn,ms)=>{const timer=realSetTimeout(fn,ms);timeouts.add(timer);return timer;}}))setGlobal(key,value);
 Date.now=()=>now;
 window.addEventListener('error',event=>errors.push(event.error));
 for(const dialog of document.querySelectorAll('dialog')) {
  dialog.showModal=()=>{dialog.open=true;};
  dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new window.Event('close'));};
 }
 const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>realSetTimeout(r,5));}throw new Error('UI wait timed out: '+document.querySelector('#shared-notice').textContent+' / '+$('toast').textContent);};
 const cleanup=()=>{
  window.dispatchEvent(new window.Event('beforeunload'));
  for(const timer of timeouts)clearTimeout(timer);
  for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
  Date.now=realNow;window.close();
 };
 try {
  await import('../dist/app.js?ui-test='+ ++instance);
  await wait(()=>document.body.dataset.connection==='connected');
  if(!missingNamed)await wait(()=>calls.some(c=>c.name==='eclipse_read_named_timers'));
  await new Promise(r=>realSetTimeout(r,20));
 }catch(error){cleanup();throw error;}
 return {$,document,window,channels,calls,intervals,errors,wait,cleanup,click:id=>$(id).click(),emit,run,
  submit:id=>$(id).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})),
  tick:milliseconds=>{now+=milliseconds;for(const {fn,ms} of intervals.values())if(ms===200)fn();},
  async remote(group,bosses,levels){const prefix=group==='named'?'named_':'',base=(await run('eclipse_read_'+prefix+'timers')).snapshot.bosses;
   const result=await run('eclipse_update_'+prefix+'timers',[JSON.stringify(bosses),JSON.stringify(base),levels,'import','bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb']);emit(group,result.snapshot);return result;}
 };
}
test('tabs show 6 field or 4 named bosses with persistent independent live connections and refresh periods',async()=>{
 const ui=await fixture();try {
  assert.equal(ui.document.querySelectorAll('.timer-row').length,6);
  assert.equal(ui.$('add-named').hidden,true);
  assert.deepEqual([...ui.intervals.values()].map(i=>i.ms).sort((a,b)=>a-b),[200,1800000,3600000]);
  const reads=ui.calls.filter(c=>c.name==='eclipse_read_named_timers').length;
  [...ui.intervals.values()].find(i=>i.ms===1800000).fn();
  await ui.wait(()=>ui.calls.filter(c=>c.name==='eclipse_read_named_timers').length===reads+1);
  const pushPreview=ui.$('push-test-preview').textContent;
  ui.click('tab-named');
  assert.equal(ui.document.querySelectorAll('.timer-row').length,4);
  assert.deepEqual([...ui.document.querySelectorAll('.timer-row')].map(n=>Number(n.dataset.level)),[71,72,73,74]);
  assert.ok([...ui.document.querySelectorAll('.interval-value')].every(n=>n.textContent==='30분'));
  assert.equal(ui.$('add-named').hidden,false);
  assert.equal(ui.$('push-test-preview').textContent,pushPreview);
  assert.equal(ui.$('tab-named').getAttribute('aria-selected'),'true');
  assert.equal(ui.$('timer-panel').getAttribute('aria-labelledby'),'tab-named');
  const before=ui.$('next-countdown').textContent;ui.tick(1000);
  assert.notEqual(ui.$('next-countdown').textContent,before);
  ui.click('tab-field');
  assert.equal(ui.document.querySelectorAll('.timer-row').length,6);
  assert.equal(ui.channels.length,2);assert.ok(ui.channels.every(c=>!c.closed));
  assert.deepEqual(ui.errors,[]);
 }finally{ui.cleanup();}
});
test('named add, edit, reset and undo operate on named state and shared additions appear while hidden',async()=>{
 const ui=await fixture();try {
  ui.click('tab-named');ui.click('add-named');
  assert.equal(ui.$('named-level').value,'75');
  ui.submit('add-form');await ui.wait(()=>!ui.$('add-dialog').open);
  assert.equal(ui.document.querySelectorAll('.timer-row').length,5);
  const row=ui.document.querySelector('[data-level="75"]');
  row.querySelector('.row-edit').click();
  ui.$('edit-fields').querySelector('[name=minutes]').value='35';
  ui.submit('edit-form');await ui.wait(()=>!ui.$('edit-dialog').open);
  assert.equal(row.querySelector('.interval-value').textContent,'35분');
  const before=(await ui.run('eclipse_read_named_timers')).snapshot.bosses;
  row.querySelector('.row-reset').click();await ui.wait(()=>!ui.$('undo').disabled);
  ui.click('undo');await ui.wait(()=>ui.$('undo').disabled);
  assert.deepEqual((await ui.run('eclipse_read_named_timers')).snapshot.bosses,before);
  ui.click('tab-field');
  await ui.remote('named',[...before,{...before[0],level:76}],[76]);
  assert.equal(ui.document.querySelectorAll('.timer-row').length,6);
  ui.click('tab-named');
  assert.equal(ui.document.querySelectorAll('.timer-row').length,6);
  assert.ok(ui.document.querySelector('[data-level="76"]'));
  assert.ok(ui.calls.filter(c=>c.args).every(c=>c.name==='eclipse_update_named_timers'));
  assert.deepEqual(ui.errors,[]);
 }finally{ui.cleanup();}
});
test('hidden named and field groups still report crossed respawns; push preview always uses field state',async()=>{
 const ui=await fixture();try {
  const named=(await ui.run('eclipse_read_named_timers')).snapshot.bosses;
  named[0].anchor_kst=kstISO(Date.now()+2000);
  await ui.remote('named',named,[71]);
  ui.tick(3000);
  assert.ok(ui.$('toast').textContent.includes('네임드 Lv.71'));
  ui.click('tab-named');
  const field=(await ui.run('eclipse_read_timers')).snapshot.bosses;
  field[0].anchor_kst=kstISO(Date.now()+2000);
  await ui.remote('field',field,[40]);
  assert.ok(ui.$('push-test-preview').textContent.includes('필보 Lv.40'));
  ui.tick(3000);
  assert.ok(ui.$('toast').textContent.includes('필보 Lv.40'));
  assert.ok(ui.calls.every(c=>!c.name.startsWith('eclipse_push_')));
  assert.deepEqual(ui.errors,[]);
 }finally{ui.cleanup();}
});
test('missing named migration disables its controls while field editing keeps working',async()=>{
 const ui=await fixture({missingNamed:true});try {
  assert.equal(ui.$('edit-all').disabled,false);
  ui.click('tab-named');
  assert.equal(ui.document.body.dataset.connection,'unconfigured');
  assert.equal(ui.$('add-named').disabled,true);
  assert.equal(ui.$('edit-all').disabled,true);
  assert.equal(ui.$('next-countdown').textContent,'--:--:--');
  assert.equal(ui.$('named-setup-link').hidden,false);
  ui.click('tab-field');
  assert.equal(ui.$('edit-all').disabled,false);
  assert.equal(ui.document.body.dataset.connection,'connected');
  assert.deepEqual(ui.errors,[]);
 }finally{ui.cleanup();}
});
test('keyboard tabs, independent sorting and shared audio preferences survive switching',async()=>{
 const ui=await fixture();try {
  ui.$('tab-field').dispatchEvent(new ui.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert.equal(ui.$('tab-named').getAttribute('aria-selected'),'true');
  ui.document.querySelector('[data-sort=next]').click();
  ui.$('sound-volume').value='63';ui.$('sound-volume').dispatchEvent(new ui.window.Event('input'));
  ui.click('tab-field');
  assert.equal(ui.$('sound-volume').value,'63');
  assert.equal(ui.document.querySelector('[data-sort=level]').getAttribute('aria-pressed'),'true');
  ui.click('tab-named');
  assert.equal(ui.document.querySelector('[data-sort=next]').getAttribute('aria-pressed'),'true');
  assert.equal(ui.$('sound-volume').value,'63');
  assert.deepEqual(ui.errors,[]);
 }finally{ui.cleanup();}
});
