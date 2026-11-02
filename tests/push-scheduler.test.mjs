import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {kstISO} from '../dist/core.js';
import {combinePushSQL} from '../dist/push-setup-core.js';
const db=new PGlite();
const A='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',token='a'.repeat(43);
const run=(name,args=[])=>db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as value',args).then(r=>r.rows[0].value);
const owner=()=>db.exec('reset role;'),anon=()=>db.exec('set role anon;');
const save=(id=A)=>run('eclipse_push_save',[id,token,JSON.stringify({endpoint:'https://web.push.apple.com/test/'+id,keys:{p256dh:'B'.repeat(87),auth:'C'.repeat(22)}})]);
const config=()=>db.query('select * from public.eclipse_push_config').then(r=>r.rows[0]);
const jobs=()=>db.query('select * from cron.job order by jobname').then(r=>r.rows);
const calls=()=>db.query('select count(*)::integer as n from net.calls').then(r=>r.rows[0].n);
let coreSQL,schedulerSQL,bosses;
before(async()=>{
 await db.exec('create role anon; create role authenticated; create role service_role;');
 await db.exec(await readFile(new URL('../supabase/setup.sql',import.meta.url),'utf8'));
 coreSQL=await readFile(new URL('../supabase/push.sql',import.meta.url),'utf8');
 schedulerSQL=await readFile(new URL('../supabase/push-scheduler.sql',import.meta.url),'utf8');
 await db.exec(coreSQL);
 // Isolate external cron and HTTP while running real SQL, RLS and triggers.
 await db.exec("\n create schema cron;\n create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,username text default current_user);\n create table cron.job_run_details(command text,end_time timestamptz);\n create function cron.schedule(p_name text,p_schedule text,p_command text) returns bigint language sql as $$\n insert into cron.job(jobname,schedule,command) values(p_name,p_schedule,p_command)\n on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid;\n $$;\n create function cron.unschedule(p_id bigint) returns boolean language plpgsql as $$\n begin delete from cron.job where jobid=p_id;return found;end;$$;\n create schema vault;\n create table vault.decrypted_secrets(name text,decrypted_secret text);\n insert into vault.decrypted_secrets values('eclipse_push_dispatch','fake-test-secret');\n create schema net;\n create table net.calls(id bigint generated always as identity,url text,headers jsonb,body jsonb);\n create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$\n insert into net.calls(url,headers,body) values($1,$2,$3) returning id;$$;\n");
 await db.exec(schedulerSQL);
});
after(()=>db.close());
beforeEach(async()=>{
 await owner();
 await db.exec("set cron.timezone='GMT'; truncate public.eclipse_push_subscriptions cascade; truncate cron.job,cron.job_run_details,net.calls; update public.eclipse_push_config set enabled=false,wake_at=null,wake_job_id=null,dispatch_requested_at=null,broadcast_requested_at=null,housekeeping_at=null,public_key='test-public',last_checked=clock_timestamp();");
 bosses=[40,50,60,70,75,80].map((level,i)=>({level,interval_seconds:28800,anchor_kst:kstISO(Date.now()+(i+2)*3600000)}));
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 await db.exec("update public.eclipse_push_config set enabled=true where id=1; select cron.schedule('eclipse-boss-push','0 * * * *','select public.eclipse_push_tick();');");
 await anon();
});

test('an hourly check plus one reserved warning replaces continuous minute polling',async()=>{
 await save();await owner();
 const scheduled=await jobs(),state=await config();
 assert.equal(scheduled.length,2);
 assert.equal(scheduled.find(j=>j.jobname==='eclipse-boss-push').schedule,'0 * * * *');
 const wake=scheduled.find(j=>j.jobname==='eclipse-boss-wake');
 assert.notEqual(wake.schedule,'* * * * *');
 assert.equal(new Date(state.wake_at).getTime(),Date.parse(bosses[0].anchor_kst+'+09:00')-180000);
 assert.ok(wake.command.startsWith('select public.eclipse_push_wake('));
 assert.equal(await calls(),0);
});

test('editing shared times moves the reservation immediately and stale callbacks do nothing',async()=>{
 await save();await owner();const previous=await config();
 bosses[5].anchor_kst=kstISO(Date.now()+70*60000);
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 const changed=await config();
 assert.notEqual(new Date(previous.wake_at).getTime(),new Date(changed.wake_at).getTime());
 assert.equal(new Date(changed.wake_at).getTime(),Date.parse(bosses[5].anchor_kst+'+09:00')-180000);
 await run('eclipse_push_wake',[previous.wake_at]);
 assert.equal((await config()).wake_job_id,changed.wake_job_id);
 assert.equal(await calls(),0);
});

test('a change inside three minutes requests an immediate warning to every subscriber',async()=>{
 await save();await save(B);await owner();
 bosses[5].anchor_kst=kstISO(Date.now()+120000);
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 assert.equal(await calls(),1);
 const queued=(await db.query('select * from public.eclipse_push_jobs')).rows;
 assert.equal(queued.length,2);
 assert.deepEqual(queued[0].payload,queued[1].payload);
 assert.equal(new Date(queued[0].expires_at).getTime(),Date.parse(bosses[5].anchor_kst+'+09:00'));
 assert.ok(queued[0].event_key.startsWith('warning:80:'));
 bosses[5].anchor_kst=kstISO(Date.now()+5*3600000);
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 assert.equal((await run('eclipse_push_claim')).length,0);
});

test('second precision uses a short reservation without sending early',async()=>{
 await owner();
 const warning=new Date(Date.now()+2*3600000);warning.setUTCSeconds(45,0);
 bosses[0].anchor_kst=kstISO(warning.getTime()+180000);
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 await anon();await save();await owner();
 await db.exec("delete from cron.job where jobname='eclipse-boss-wake';");
 await run('eclipse_push_plan',[new Date(warning.getTime()-10000).toISOString()]);
 const wake=(await jobs()).find(j=>j.jobname==='eclipse-boss-wake');
 assert.equal(wake.schedule,'10 seconds');
 assert.equal(await calls(),0);
 assert.equal((await run('eclipse_push_claim')).length,0);
});

test('cron calendar expressions respect the scheduler timezone across a day boundary',async()=>{
 await owner();await db.exec("set cron.timezone='Asia/Seoul';");
 const day=new Date(Date.now()+3*86400000);day.setUTCHours(23,59,45,0);
 const warning=day.getTime();
 bosses=bosses.map((boss,index)=>({...boss,anchor_kst:kstISO(warning+180000+index*3600000)}));
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 await anon();await save();await owner();
 const wall=kstISO(warning),wake=(await jobs()).find(j=>j.jobname==='eclipse-boss-wake');
 assert.equal(wake.schedule,wall.slice(14,16)+' '+wall.slice(11,13)+' '+wall.slice(8,10)+' '+wall.slice(5,7)+' *');
});

test('turning off the final device removes the warning reservation',async()=>{
 await save();await run('eclipse_push_remove',[A,token]);await owner();
 assert.deepEqual((await jobs()).map(j=>j.jobname),['eclipse-boss-push']);
 assert.equal((await config()).wake_at,null);
});

test('manual tests dispatch promptly and a short follow-up ends after delivery',async()=>{
 await save();await run('eclipse_push_test',[A,token]);await owner();
 assert.equal(await calls(),1);
 const queued=await run('eclipse_push_claim');assert.equal(queued.length,1);
 await run('eclipse_push_finish',[queued[0].id,'sent']);
 const pending=await config();await run('eclipse_push_wake',[pending.wake_at]);
 assert.equal(await calls(),1);
 assert.ok(new Date((await config()).wake_at).getTime()>Date.now()+3600000);
});

test('retry reservations use the lease, expire before respawn, and retain hourly health',async()=>{
 await save();await run('eclipse_push_test',[A,token]);await owner();
 const [job]=await run('eclipse_push_claim');
 await run('eclipse_push_finish',[job.id,'retry']);await run('eclipse_push_plan');
 const state=await config(),row=(await db.query('select * from public.eclipse_push_jobs where id=$1',[job.id])).rows[0];
 assert.equal(new Date(state.wake_at).getTime(),new Date(row.leased_until).getTime());
 await db.exec("update public.eclipse_push_config set last_checked=clock_timestamp()-interval '61 minutes';");
 await anon();assert.equal((await run('eclipse_push_info')).enabled,true);
 await owner();await db.exec("update public.eclipse_push_config set last_checked=clock_timestamp()-interval '91 minutes';");
 await anon();assert.equal((await run('eclipse_push_info')).enabled,false);
});

test('upgrading preserves keys and subscriptions and only prunes this timer history',async()=>{
 await save();await owner();
 await db.exec("insert into cron.job_run_details values('select public.eclipse_push_tick();',clock_timestamp()-interval '8 days'),('other application',clock_timestamp()-interval '8 days'); update public.eclipse_push_config set housekeeping_at=null;");
 await db.exec(combinePushSQL(coreSQL,schedulerSQL));
 assert.equal((await config()).public_key,'test-public');
 assert.equal((await jobs()).length,2);
 assert.deepEqual((await db.query('select command from cron.job_run_details')).rows.map(r=>r.command),['other application']);
 assert.equal((await db.query('select decrypted_secret from vault.decrypted_secrets')).rows[0].decrypted_secret,'fake-test-secret');
 await anon();assert.equal(await run('eclipse_push_status',[A,token]),true);
 await assert.rejects(run('eclipse_push_tick'),/permission denied/);
 await assert.rejects(run('eclipse_push_plan'),/permission denied/);
});

test('warning calculations cross midnight and repeat from the shifted anchor',async()=>{
 await owner();
 const boss={level:40,interval_seconds:28800,anchor_kst:'2026-11-03T00:01:30'};
 assert.equal(new Date(await run('eclipse_push_next_warning',[JSON.stringify(boss),'2026-11-02T14:58:29Z'])).toISOString(),'2026-11-02T14:58:30.000Z');
 assert.equal(new Date(await run('eclipse_push_next_warning',[JSON.stringify(boss),'2026-11-02T14:58:30Z'])).toISOString(),'2026-11-02T22:58:30.000Z');
});

test('a new warning is not delayed by a recent manual test dispatch',async()=>{
 await save();await run('eclipse_push_test',[A,token]);await owner();
 assert.equal(await calls(),1);
 bosses[5].anchor_kst=kstISO(Date.now()+180000);
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 assert.equal(await calls(),2);
 const all=(await db.query('select event_key from public.eclipse_push_jobs')).rows.map(r=>r.event_key);
 assert.ok(all.some(key=>key.startsWith('warning:80:')));
});

test('warnings are not queued early and cannot be claimed at or after respawn',async()=>{
 await save();await owner();
 bosses[0].anchor_kst=kstISO(Date.now()+240000);
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 assert.equal((await run('eclipse_push_claim')).length,0);
 bosses[0].anchor_kst=kstISO(Date.now()+179000);
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 const queued=(await db.query('select * from public.eclipse_push_jobs')).rows;
 assert.equal(queued.length,1);assert.ok(queued[0].payload.title.includes('3'));
 await db.exec("update public.eclipse_push_jobs set expires_at=clock_timestamp();");
 assert.equal((await run('eclipse_push_claim')).length,0);
});

test('first-time web setup installs the same reservations and saves matching keys atomically',async()=>{
 const {buildPushSetup,generatePushKeys}=await import('../dist/push-setup-core.js');
 await owner();
 await db.exec("alter table vault.decrypted_secrets add column id uuid default gen_random_uuid(); create view vault.secrets as select id,name from vault.decrypted_secrets;");
 await db.exec("create function vault.update_secret(p_id uuid,p_secret text,p_name text) returns void language sql as $$update vault.decrypted_secrets set decrypted_secret=p_secret,name=p_name where id=p_id;$$;");
 const cronSQL=await readFile(new URL('../supabase/push-cron.sql',import.meta.url),'utf8');
 const keys=await generatePushKeys();
 const prepared=buildPushSetup(coreSQL,cronSQL,keys,'https://xywqclfppwsiiydlniba.supabase.co',schedulerSQL);
 // pg_cron, pg_net and Vault are the external services represented by the fixtures.
 await db.exec(prepared.sql.replace(/^create extension if not exists [^\n]*;\r?$/gm,''));
 const state=await config();
 assert.equal(state.public_key,keys.publicKey);assert.equal(state.schedule_mode,'reserved');
 assert.equal((await db.query('select decrypted_secret from vault.decrypted_secrets')).rows[0].decrypted_secret,keys.dispatchSecret);
 assert.equal((await jobs()).find(job=>job.jobname==='eclipse-boss-push').schedule,'0 * * * *');
});
