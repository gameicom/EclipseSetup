import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { defaultSettings, parseKST } from '../dist/core.js';
import { SharedTimer, ConflictError, validateConfiguration } from '../dist/shared.js';
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const defaults=()=>defaultSettings().bosses;
const db=new PGlite();
const migration=await readFile(new URL('../supabase/setup.sql',import.meta.url),'utf8');
const clients=[];
const subscribers=new Set();
before(async()=>{
  await db.exec('create role anon; create role authenticated;');
  await db.exec(migration);
});
beforeEach(async()=>{
  for(const client of clients.splice(0)) await client.stop();
  subscribers.clear();
  await db.exec('reset role;');
  await db.query("update public.eclipse_timer_state set bosses=$1::jsonb,revision=0,client_id=null,last_action='initial',updated_at=clock_timestamp() where id=1",[JSON.stringify(defaults())]);
  await db.exec('set role anon;');
});
after(async()=>{for(const client of clients) await client.stop(); await db.close();});
async function read(){return (await db.query('select public.eclipse_read_timers() as result')).rows[0].result;}
async function write(bosses,base,levels,action='edit',clientId=A){
  return (await db.query('select public.eclipse_update_timers($1::jsonb,$2::jsonb,$3::integer[],$4::text,$5::uuid) as result',
    [JSON.stringify(bosses),JSON.stringify(base),levels,action,clientId])).rows[0].result;
}
const edit=(base,index,seconds)=>{const next=structuredClone(base);next[index].interval_seconds=seconds;return next;};
async function waitFor(check){
  for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,5));}
  throw new Error('Condition not reached');
}
function transport(){
  const api={offline:false,loseWriteReply:false,status:null,callback:null};
  api.channel=()=>({
    on(_event,_filter,callback){api.callback=callback;return this;},
    subscribe(status){api.status=status;subscribers.add(api);queueMicrotask(()=>status('SUBSCRIBED'));return this;}
  });
  api.removeChannel=async()=>{subscribers.delete(api);};
  api.rpc=async(name,args)=>{
    if(api.offline)return {data:null,error:{message:'Offline'}};
    try{
      let data;
      if(name==='eclipse_read_timers')data=await read();
      else{
        data=await write(args.p_bosses,args.p_base,args.p_levels,args.p_action,args.p_client_id);
        if(data.status==='ok')for(const listener of subscribers)if(!listener.offline)listener.callback({new:data.snapshot});
        if(api.loseWriteReply){api.loseWriteReply=false;return {data:null,error:{message:'Reply lost'}};}
      }
      return {data,error:null};
    }catch(error){return {data:null,error:{message:error.message}};}
  };
  return api;
}
async function connect(id,api=transport(),options={}){
  const client=new SharedTimer({client:api,clientId:id,refreshInterval:0,...options});
  clients.push(client);await client.start();await waitFor(()=>client.ready);return {client,api};
}
test('anonymous visitors read a shared singleton but cannot write/delete it directly',async()=>{
  assert.deepEqual((await read()).snapshot.bosses,defaults());
  await assert.rejects(db.query("update public.eclipse_timer_state set revision=999 where id=1"),/permission denied/);
  await assert.rejects(db.query("delete from public.eclipse_timer_state"),/permission denied/);
  assert.equal((await read()).snapshot.revision,0);
});
test('different visitors can edit different bosses without overwriting each other',async()=>{
  const base=defaults();
  const first=await write(edit(base,0,3600),base,[40]);
  const second=await write(edit(base,1,7200),base,[50],'edit',B);
  assert.equal(first.status,'ok');assert.equal(second.status,'ok');
  assert.equal(second.snapshot.bosses[0].interval_seconds,3600);
  assert.equal(second.snapshot.bosses[1].interval_seconds,7200);
  assert.equal(second.snapshot.revision,2);
});
test('a stale edit of the same boss is rejected atomically',async()=>{
  const base=defaults();
  await write(edit(base,0,3600),base,[40]);
  const proposed=edit(edit(base,0,7200),1,14400);
  const second=await write(proposed,base,[40,50],'edit',B);
  assert.equal(second.status,'conflict');
  assert.deepEqual(second.conflicting_levels,[40]);
  assert.equal(second.snapshot.bosses[0].interval_seconds,3600);
  assert.equal(second.snapshot.bosses[1].interval_seconds,28800);
  assert.equal(second.snapshot.revision,1);
});
test('undo restores only its own affected bosses and preserves other edits',async()=>{
  const original=defaults();
  const first=await write(edit(original,0,3600),original,[40]);
  await write(edit(original,1,7200),original,[50],'edit',B);
  const undone=await write(original,first.snapshot.bosses,[40],'undo');
  assert.equal(undone.status,'ok');
  assert.equal(undone.snapshot.bosses[0].interval_seconds,28800);
  assert.equal(undone.snapshot.bosses[1].interval_seconds,7200);
});
test('undo cannot overwrite a later change to the same boss',async()=>{
  const original=defaults();
  const first=await write(edit(original,0,3600),original,[40]);
  await write(edit(first.snapshot.bosses,0,7200),first.snapshot.bosses,[40],'edit',B);
  const undone=await write(original,first.snapshot.bosses,[40],'undo');
  assert.equal(undone.status,'conflict');
  assert.equal(undone.snapshot.bosses[0].interval_seconds,7200);
});
test('reset uses one server clock and preserves each respawn interval',async()=>{
  const base=defaults();
  const proposed=base.map(b=>({...b,anchor_kst:'2000-01-01T00:00:00',interval_seconds:1}));
  const result=await write(proposed,base,[40,50,60,70,75,80],'reset');
  assert.equal(new Set(result.snapshot.bosses.map(b=>b.anchor_kst)).size,1);
  assert.ok(Math.abs(parseKST(result.snapshot.bosses[0].anchor_kst)-Date.now())<5000);
  assert.deepEqual(result.snapshot.bosses.map(b=>b.interval_seconds),base.map(b=>b.interval_seconds));
});
test('database rejects malformed dates, intervals, boss lists and unknown fields',async()=>{
  for(const mutate of [
    b=>{b[0].interval_seconds=0;},b=>{b[0].interval_seconds=1.5;},
    b=>{b[0].anchor_kst='2026-02-30T00:00:00';},
    b=>{b[0].level=80;},b=>{b[0].unexpected='payload';},b=>{b.pop();}
  ]){
    const bosses=defaults();mutate(bosses);
    await assert.rejects(write(bosses,defaults(),[40]),/INVALID_TIMER_SETTINGS/);
  }
  await assert.rejects(write(defaults(),defaults(),[40,40]),/INVALID_TIMER_SETTINGS/);
  await assert.rejects(write(defaults(),defaults(),[99]),/INVALID_TIMER_SETTINGS/);
  assert.equal((await read()).snapshot.revision,0);
});
test('migration can be re-run without resetting shared data',async()=>{
  await write(edit(defaults(),0,3600),defaults(),[40]);
  await db.exec('reset role;');
  await db.exec(migration);
  await db.exec('set role anon;');
  assert.equal((await read()).snapshot.bosses[0].interval_seconds,3600);
});
test('two independent clients receive committed changes through the realtime transport contract',async()=>{
  const {client:a}=await connect(A),{client:b}=await connect(B);
  const base=structuredClone(a.snapshot.bosses);
  await a.update({bosses:edit(base,0,3600),base,levels:[40],action:'edit'});
  assert.equal(b.snapshot.bosses[0].interval_seconds,3600);
  assert.equal(b.snapshot.revision,1);
  const baseB=structuredClone(b.snapshot.bosses);
  await b.update({bosses:edit(baseB,4,9000),base:baseB,levels:[75],action:'edit'});
  assert.equal(a.snapshot.bosses[4].interval_seconds,9000);
  assert.equal(a.snapshot.revision,2);
});
test('client rejects stale saves while updating its display to the latest snapshot',async()=>{
  const {client:a}=await connect(A),{client:b}=await connect(B);
  const stale=structuredClone(a.snapshot.bosses);
  await b.update({bosses:edit(stale,0,3600),base:stale,levels:[40],action:'edit'});
  await assert.rejects(a.update({bosses:edit(stale,0,7200),base:stale,levels:[40],action:'edit'}),ConflictError);
  assert.equal(a.snapshot.bosses[0].interval_seconds,3600);
  assert.equal(a.ready,true);
});
test('disconnect disables edits; reconnect reads current state without replaying local data',async()=>{
  const {client:a,api}=await connect(A),{client:b}=await connect(B);
  api.offline=true;api.status('CLOSED');
  assert.equal(a.ready,false);
  await assert.rejects(a.update({bosses:defaults(),base:defaults(),levels:[40],action:'edit'}),/연결/);
  const base=structuredClone(b.snapshot.bosses);
  await b.update({bosses:edit(base,1,7200),base,levels:[50],action:'edit'});
  assert.equal(a.snapshot.revision,0);
  api.offline=false;api.status('SUBSCRIBED');
  await waitFor(()=>a.ready&&a.snapshot.revision===1);
  assert.equal(a.snapshot.bosses[1].interval_seconds,7200);
});
test('late snapshots cannot roll the client back and server time corrects device clock drift',async()=>{
  const {client}=await connect(A,transport(),{now:()=>Date.now()+600000});
  assert.ok(Math.abs(client.now()-Date.now())<1000);
  const old=structuredClone(client.snapshot);
  await client.update({bosses:edit(old.bosses,0,3600),base:old.bosses,levels:[40],action:'edit'});
  client.accept(old,'realtime');
  assert.equal(client.snapshot.revision,1);
});
test('a lost save response refreshes authoritative data and never retries the write silently',async()=>{
  const {client,api}=await connect(A);
  api.loseWriteReply=true;
  await assert.rejects(client.update({bosses:edit(defaults(),0,3600),base:defaults(),levels:[40],action:'edit'}),/저장 응답/);
  assert.equal(client.snapshot.bosses[0].interval_seconds,3600);
  assert.equal(client.snapshot.revision,1);
  assert.equal(client.ready,true);
});
test('missing configuration and privileged keys never enable a fake shared mode',()=>{
  assert.throws(()=>validateConfiguration({}),/실시간 공유가 작동하지/);
  assert.throws(()=>validateConfiguration({supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'sb_secret_private'}),/publishable/);
  const jwt='x.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.x';
  assert.throws(()=>validateConfiguration({supabaseUrl:'https://example.supabase.co',supabasePublishableKey:jwt}),/publishable/);
  assert.equal(validateConfiguration({supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'sb_publishable_example'}).url,'https://example.supabase.co');
});
