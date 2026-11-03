import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {defaultNamedSettings,validateNamedSettings} from '../dist/named.js';
import {defaultSettings,kstISO,parseKST,nextOccurrence} from '../dist/core.js';
import {SharedTimer,parseSnapshot,ConflictError} from '../dist/shared.js';
const db=new PGlite(),A='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const migration=await readFile(new URL('../supabase/named.sql',import.meta.url),'utf8');
const defaults=()=>defaultNamedSettings(Date.parse('2026-11-03T00:00:00Z')).bosses;
const owner=()=>db.exec('reset role;'),anon=()=>db.exec('set role anon;');
const rpc=(name,args=[])=>db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as value',args).then(r=>r.rows[0].value);
const read=()=>rpc('eclipse_read_named_timers');
const write=(bosses,base,levels,action='edit',id=A)=>rpc('eclipse_update_named_timers',[JSON.stringify(bosses),JSON.stringify(base),levels,action,id]);
const edit=(bosses,level,interval=900)=>bosses.map(b=>b.level===level?{...b,interval_seconds:interval}:b);
before(async()=>{
 await db.exec('create role anon;create role authenticated;');
 await db.exec(await readFile(new URL('../supabase/setup.sql',import.meta.url),'utf8'));
 await db.exec(migration);
});
after(()=>db.close());
beforeEach(async()=>{
 await owner();
 await db.query('update public.eclipse_named_timer_state set bosses=$1,revision=0,client_id=null,last_action=$2 where id=1',[JSON.stringify(defaults()),'initial']);
 await anon();
});
test('four named defaults recur every 30 minutes; backups are distinct from field timers',()=>{
 const value=defaultNamedSettings();
 assert.deepEqual(value.bosses.map(b=>b.level),[71,72,73,74]);
 assert.ok(value.bosses.every(b=>b.interval_seconds===1800));
 const boss=value.bosses[0],anchor=parseKST(boss.anchor_kst);
 assert.equal(nextOccurrence(boss,anchor),anchor+1800000);
 assert.equal(nextOccurrence(boss,anchor+1800000),anchor+3600000);
 assert.deepEqual(validateNamedSettings(value),value);
 assert.throws(()=>validateNamedSettings(defaultSettings()),/네임드/);
 assert.throws(()=>parseSnapshot({bosses:value.bosses,revision:0,updated_at:new Date().toISOString()}));
 assert.deepEqual(parseSnapshot({bosses:value.bosses,revision:0,updated_at:new Date().toISOString()},'named').bosses,value.bosses);
});
test('public visitors read named timers but cannot directly write, remove or insert state',async()=>{
 assert.deepEqual((await read()).snapshot.bosses,defaults());
 for(const sql of ['delete from public.eclipse_named_timer_state','update public.eclipse_named_timer_state set revision=99','insert into public.eclipse_named_timer_state(id,bosses) values(2,\'[]\')'])
  await assert.rejects(db.exec(sql),/permission denied/);
});
test('adding 75 and 76 from stale independent snapshots preserves both additions',async()=>{
 const base=defaults(),added=level=>[...base,{...base[0],level}];
 assert.equal((await write(added(75),base,[75],'add')).status,'ok');
 const other=await write(added(76),base,[76],'add',B);
 assert.deepEqual(other.snapshot.bosses.map(b=>b.level),[71,72,73,74,75,76]);
 const duplicate=await write(added(75),base,[75],'add',B);
 assert.equal(duplicate.status,'conflict');
 assert.deepEqual(duplicate.conflicting_levels,[75]);
});
test('edits merge by named level, conflicts are atomic and field 75 stays unchanged',async()=>{
 const base=defaults();
 await write(edit(base,71),base,[71]);
 const merged=await write(edit(base,72,1200),base,[72]);
 assert.equal(merged.snapshot.bosses[0].interval_seconds,900);
 assert.equal(merged.snapshot.bosses[1].interval_seconds,1200);
 const conflict=await write(edit(edit(base,71,600),73,600),base,[73,71]);
 assert.equal(conflict.status,'conflict');
 assert.equal((await read()).snapshot.bosses[2].interval_seconds,1800);
 await write([...base,{...base[0],level:75}],base,[75],'add');
 assert.deepEqual((await rpc('eclipse_read_timers')).snapshot.bosses,defaultSettings().bosses);
});
test('reset uses one server clock and undo merges without removing subsequent additions',async()=>{
 const base=defaults();
 const reset=await write(base,base,[71,72],'reset');
 assert.equal(reset.snapshot.bosses[0].anchor_kst,reset.snapshot.bosses[1].anchor_kst);
 assert.ok(Math.abs(parseKST(reset.snapshot.bosses[0].anchor_kst)-Date.now())<3000);
 assert.equal(reset.snapshot.bosses[0].interval_seconds,1800);
 await write([...reset.snapshot.bosses,{...base[0],level:75}],reset.snapshot.bosses,[75],'add');
 const undone=await write(base,reset.snapshot.bosses,[71,72],'undo');
 assert.equal(undone.snapshot.bosses.length,5);
 assert.equal(undone.snapshot.bosses[0].anchor_kst,base[0].anchor_kst);
});
test('imports merge supplied levels and preserve unmentioned or newly added named timers',async()=>{
 const base=defaults();
 const result=await write([{...base[0],interval_seconds:600},{...base[0],level:76}],base,[71,76],'import');
 assert.deepEqual(result.snapshot.bosses.map(b=>b.level),[71,72,73,74,76]);
 assert.equal(result.snapshot.bosses[0].interval_seconds,600);
});
test('invalid levels, duplicate levels, dates, periods, actions and payload fields are rejected',async()=>{
 for(const mutation of [
 b=>b[0].level=0,b=>b[0].level=1000,b=>b[0].level=71.5,b=>b[1].level=71,
 b=>b[0].anchor_kst='2026-02-30T00:00:00',b=>b[0].interval_seconds=0,
 b=>b[0].interval_seconds=1800.5,b=>b[0].interval_seconds=3600000,b=>b[0].secret='extra',b=>b.splice(0)
 ]) {
  const invalid=structuredClone(defaults());mutation(invalid);
  await assert.rejects(write(invalid,defaults(),[71]),/INVALID_NAMED_SETTINGS/);
 }
 await assert.rejects(write(defaults(),defaults(),[71,71]),/INVALID_NAMED_SETTINGS/);
 await assert.rejects(write(defaults(),defaults(),[75]),/INVALID_NAMED_SETTINGS/);
 await assert.rejects(write(defaults(),defaults(),[71],'add'),/INVALID_NAMED_SETTINGS/);
 await assert.rejects(write(defaults(),defaults(),[71],'delete'),/INVALID_NAMED_SETTINGS/);
 assert.equal((await read()).snapshot.revision,0);
});
test('the 64-boss cap applies to the merged state after concurrent additions',async()=>{
 const full=Array.from({length:64},(_,i)=>({...defaults()[0],level:i+1}));
 await owner();await db.query('update public.eclipse_named_timer_state set bosses=$1 where id=1',[JSON.stringify(full)]);await anon();
 const stale=full.slice(0,63),proposed=[...stale,{...stale[0],level:99}];
 await assert.rejects(write(proposed,stale,[99],'add'),/NAMED_BOSS_LIMIT/);
 assert.equal((await read()).snapshot.bosses.length,64);
});
test('re-running named setup preserves additions, edited times and field settings',async()=>{
 const base=defaults();
 await write([...edit(base,71),{...base[0],level:75}],base,[71,75],'import');
 const before=await read();
 await owner();await db.exec(migration);await anon();
 assert.deepEqual((await read()).snapshot,before.snapshot);
 assert.deepEqual((await rpc('eclipse_read_timers')).snapshot.bosses,defaultSettings().bosses);
});

test('two named clients share additions immediately, retain 30-minute refresh, and reject stale writes',async()=>{
 const listeners=new Set(),channels=[];
 const transport={
  channel(name){const c={name,on(_event,filter,callback){c.filter=filter;c.callback=callback;return c;},
   subscribe(status){c.status=status;listeners.add(c);queueMicrotask(()=>status('SUBSCRIBED'));return c;}};channels.push(c);return c;},
  async removeChannel(c){listeners.delete(c);},
  async rpc(name,args) {
   try {
    const data=name==='eclipse_read_named_timers'?await read():await write(args.p_bosses,args.p_base,args.p_levels,args.p_action,args.p_client_id);
    if(args&&data.status==='ok') for(const c of listeners)c.callback({new:data.snapshot});
    return {data,error:null};
   }catch(error){return {data:null,error};}
  }
 };
 const a=new SharedTimer({client:transport,clientId:A,group:'named'}),b=new SharedTimer({client:transport,clientId:B,group:'named'});
 try {
  assert.equal(a.refreshInterval,1800000);
  assert.equal(new SharedTimer({client:transport}).refreshInterval,3600000);
  await a.start();await b.start();
  assert.ok(a.ready&&b.ready);
  const base=a.snapshot.bosses;
  await a.update({bosses:[...base,{...base[0],level:75}],base,levels:[75],action:'add'});
  assert.equal(b.snapshot.bosses.length,5);
  await assert.rejects(b.update({bosses:[...base,{...base[0],level:75}],base,levels:[75],action:'add'}),ConflictError);
  assert.ok(channels.every(c=>c.filter.table==='eclipse_named_timer_state'));
  channels[0].status('CLOSED');assert.equal(a.ready,false);
  await b.update({bosses:edit(b.snapshot.bosses,71,1200),base:b.snapshot.bosses,levels:[71],action:'edit'});
  channels[0].status('SUBSCRIBED');await a.refresh();
  assert.equal(a.snapshot.bosses[0].interval_seconds,1200);
 }finally{await a.stop();await b.stop();}
});
test('missing named SQL is reported separately and never substitutes field defaults',async()=>{
 const client=new SharedTimer({client:{rpc:async()=>({data:null,error:{code:'PGRST202'}})},group:'named'});
 let phase;
 client.onStatus=status=>{phase=status.phase;};
 await client.refresh();
 assert.equal(phase,'unconfigured');
 assert.equal(client.snapshot,null);
 assert.equal(client.ready,false);
});

test('first installation creates 71 through 74 at one current server time with 30-minute intervals',async()=>{
 await owner();await db.exec('truncate public.eclipse_named_timer_state;');await db.exec(migration);await anon();
 const initial=(await read()).snapshot;
 assert.deepEqual(initial.bosses.map(b=>b.level),[71,72,73,74]);
 assert.ok(initial.bosses.every(b=>b.interval_seconds===1800));
 assert.equal(new Set(initial.bosses.map(b=>b.anchor_kst)).size,1);
 assert.ok(Math.abs(parseKST(initial.bosses[0].anchor_kst)-Date.now())<3000);
 assert.equal(initial.revision,0);
});
