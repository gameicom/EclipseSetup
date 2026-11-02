import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createECDH,randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import webpush from 'web-push';
import {createPushHandler,validPushEndpoint} from '../supabase/functions/boss-push/handler.js';
import {readAudioPreference,playAlarm} from '../dist/audio.js';
import {kstISO} from '../dist/core.js';
const db=new PGlite();
const A='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const token='a'.repeat(43),other='b'.repeat(43);
const sub=id=>({endpoint:'https://fcm.googleapis.com/test/'+id,keys:{p256dh:'B'.repeat(87),auth:'C'.repeat(22)}});
const run=(name,args=[])=>db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as value',args).then(r=>r.rows[0].value);
const save=(id=A,secret=token,value=sub(id))=>run('eclipse_push_save',[id,secret,JSON.stringify(value)]);
const role=name=>db.exec('set role '+name);
before(async()=>{
 await db.exec('create role anon; create role authenticated; create role service_role;');
 await db.exec(await readFile(new URL('../supabase/setup.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/push.sql',import.meta.url),'utf8'));
});
after(()=>db.close());
beforeEach(async()=>{
 await db.exec("reset role; truncate public.eclipse_push_subscriptions cascade; update public.eclipse_push_config set enabled=true,public_key='test-key',last_checked=clock_timestamp()-interval '90 seconds' where id=1;");
 const now=Date.now();
 const bosses=[40,50,60,70,75,80].map((level,index)=>({level,interval_seconds:28800,anchor_kst:kstISO(now+(index?86400000:-40000))}));
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 await role('anon');
});
async function seeded() {
 await save(A);await save(B,other);
 await db.exec("reset role; update public.eclipse_push_subscriptions set created_at=clock_timestamp()-interval '1 day';");
 await role('service_role');
}
test('public visitors cannot read private endpoints or trigger delivery',async()=>{
 assert.equal((await run('eclipse_push_info')).enabled,true);
 await save();
 await assert.rejects(db.query('select * from public.eclipse_push_subscriptions'),/permission denied/);
 await assert.rejects(run('eclipse_push_claim'),/permission denied/);
 await assert.rejects(run('eclipse_push_enqueue'),/permission denied/);
 assert.equal(await run('eclipse_push_status',[A,token]),true);
 assert.equal(await run('eclipse_push_status',[A,other]),false);
});
test('subscription ownership protects updates, removal and test notifications',async()=>{
 await save();
 await assert.rejects(save(A,other),/PUSH_ACCESS_DENIED/);
 await assert.rejects(run('eclipse_push_remove',[A,other]),/PUSH_ACCESS_DENIED/);
 await assert.rejects(run('eclipse_push_test',[A,other]),/PUSH_ACCESS_DENIED/);
 await run('eclipse_push_remove',[A,token]);
 assert.equal(await run('eclipse_push_status',[A,token]),false);
});
test('public registration rejects arbitrary servers and malformed push keys',async()=>{
 for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://fcm.googleapis.com:8443/x','https://name@fcm.googleapis.com/x']) {
  await assert.rejects(save(A,token,{...sub(A),endpoint}),/INVALID_PUSH_SUBSCRIPTION/);
 }
 await assert.rejects(save(A,token,{...sub(A),keys:{auth:'x',p256dh:'bad'}}),/INVALID_PUSH_SUBSCRIPTION/);
 await db.exec('reset role; update public.eclipse_push_config set enabled=false;');
 await role('anon');
 await assert.rejects(save(),/PUSH_NOT_CONFIGURED/);
});
test('due alarms use current shared times and queue each occurrence once per device',async()=>{
 await seeded();
 assert.equal(await run('eclipse_push_enqueue'),2);
 assert.equal(await run('eclipse_push_enqueue'),0);
 await db.exec("reset role; update public.eclipse_push_config set last_checked=clock_timestamp()-interval '90 seconds';");
 await role('service_role');
 assert.equal(await run('eclipse_push_enqueue'),0);
 const jobs=await run('eclipse_push_claim');
 assert.equal(jobs.length,2);
 assert.match(jobs[0].payload.title,/Lv.40/);
 assert.equal((await run('eclipse_push_claim')).length,0,'leased jobs cannot be claimed again');
 for(const job of jobs) await run('eclipse_push_finish',[job.id,'sent']);
 assert.equal((await run('eclipse_push_claim')).length,0);
});
test('editing a boss cancels queued alarms based on its old settings',async()=>{
 await seeded();await run('eclipse_push_enqueue');
 await db.exec("reset role; update public.eclipse_timer_state set bosses=jsonb_set(bosses,'{0,interval_seconds}','3600');");
 await role('service_role');
 assert.equal((await run('eclipse_push_claim')).length,0);
});
test('new subscribers do not get earlier alarms and old missed alarms are not replayed',async()=>{
 await save();
 await role('service_role');
 assert.equal(await run('eclipse_push_enqueue'),0);
 await db.exec("reset role; update public.eclipse_push_subscriptions set created_at=clock_timestamp()-interval '1 day'; update public.eclipse_push_config set last_checked=clock_timestamp()-interval '1 day';");
 await db.query("update public.eclipse_timer_state set bosses=jsonb_set(bosses,'{0,anchor_kst}',to_jsonb($1::text))",[kstISO(Date.now()-600000)]);
 await role('service_role');
 assert.equal(await run('eclipse_push_enqueue'),0);
});
test('test delivery is device-local and rate limited; expired endpoints are removed',async()=>{
 await save();await save(B,other);
 await run('eclipse_push_test',[A,token]);
 await assert.rejects(run('eclipse_push_test',[A,token]),/WAIT_ONE_MINUTE/);
 await role('service_role');
 const jobs=await run('eclipse_push_claim');
 assert.equal(jobs.length,1);
 assert.equal(jobs[0].subscription.endpoint,sub(A).endpoint);
 await run('eclipse_push_finish',[jobs[0].id,'gone']);
 await role('anon');
 assert.equal(await run('eclipse_push_status',[A,token]),false);
 assert.equal(await run('eclipse_push_status',[B,other]),true);
});
test('temporary failures retry after a lease but stop after three attempts',async()=>{
 await save();await run('eclipse_push_test',[A,token]);await role('service_role');
 for(let attempt=0;attempt<3;attempt++) {
  const jobs=await run('eclipse_push_claim');assert.equal(jobs.length,1);
  await run('eclipse_push_finish',[jobs[0].id,'retry']);
  assert.equal((await run('eclipse_push_claim')).length,0);
  await db.exec("reset role; update public.eclipse_push_jobs set leased_until=clock_timestamp()-interval '1 second';");
  await role('service_role');
 }
 assert.equal((await run('eclipse_push_claim')).length,0);
});
test('push migration preserves device registrations and current timer times',async()=>{
 await save();
 const before=(await db.query('select bosses from public.eclipse_timer_state')).rows[0].bosses;
 await db.exec('reset role;');
 await db.exec(await readFile(new URL('../supabase/push.sql',import.meta.url),'utf8'));
 await role('anon');
 assert.equal(await run('eclipse_push_status',[A,token]),true);
 assert.deepEqual((await db.query('select bosses from public.eclipse_timer_state')).rows[0].bosses,before);
});
test('volume supports mute, preserves legacy preferences and schedules louder non-overlapping pulses',()=>{
 assert.deepEqual(readAudioPreference({sound:true}),{sound:true,volume:80});
 assert.equal(readAudioPreference({volume:-10}).volume,0);
 assert.equal(readAudioPreference({volume:Infinity}).volume,80);
 assert.equal(readAudioPreference({volume:120}).volume,100);
 const pulses=[];
 const context={state:'running',currentTime:10,destination:{},createOscillator(){
   const pulse={frequency:{},connect(){},disconnect(){},start(time){this.startAt=time;},stop(time){this.stopAt=time;}};
   pulses.push(pulse);return pulse;
 },createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(value){assert.ok(value>0&&value<=0.7);},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}};
 assert.equal(playAlarm(context,0),false);assert.equal(pulses.length,0);
 assert.equal(playAlarm(context,100),true);assert.equal(pulses.length,6);
 for(let i=1;i<pulses.length;i++)assert.ok(pulses[i].startAt>pulses[i-1].stopAt);
 for(const pulse of pulses)pulse.onended();
});
test('dispatch authenticates the scheduler, encrypts push data, and removes expired subscriptions',async()=>{
 const vapid=webpush.generateVAPIDKeys(),receiver=createECDH('prime256v1');receiver.generateKeys();
 const subscription={endpoint:'https://fcm.googleapis.com/test/real-encryption',keys:{p256dh:receiver.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 const values={ECLIPSE_PUSH_SECRET:'dispatch-secret',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-key',ECLIPSE_VAPID_PUBLIC_KEY:vapid.publicKey,ECLIPSE_VAPID_PRIVATE_KEY:vapid.privateKey};
 let claimed=false,deliveries=0;const results=[];
 const handler=createPushHandler({env:key=>values[key],generateRequestDetails:webpush.generateRequestDetails.bind(webpush),fetchImpl:async(url,options)=>{
  if(url.endsWith('/eclipse_push_claim')) {const jobs=claimed?[]:[{id:1,subscription,payload:{title:'Private alarm',body:'Boss time'}}];claimed=true;return Response.json(jobs);}
  if(url.endsWith('/eclipse_push_finish')) {results.push(JSON.parse(options.body));return Response.json(true);}
  assert.equal(url,subscription.endpoint);deliveries++;
  assert.equal(options.headers['Content-Encoding'],'aes128gcm');
  assert.ok(!Buffer.from(options.body).includes(Buffer.from('Private alarm')));
  assert.equal(options.redirect,'error');
  return new Response(null,{status:410});
 }});
 assert.equal((await handler(new Request('https://test/push',{method:'POST',body:'{}'}))).status,401);
 assert.equal(deliveries,0);
 const response=await handler(new Request('https://test/push',{method:'POST',headers:{Authorization:'Bearer dispatch-secret'},body:'{}'}));
 assert.equal(response.status,200);assert.equal(deliveries,1);assert.deepEqual(results,[{p_id:1,p_result:'gone'}]);
 for(const url of ['https://localhost/x','https://fcm.googleapis.com:8443/x','https://user@fcm.googleapis.com/x','https://fcm.googleapis.com.evil.test/x']) assert.equal(validPushEndpoint(url),false);
});

test('browser-generated VAPID keys work with the real push encoder and private keys stay out of SQL',async()=>{
 const {generatePushKeys,buildPushSetup}=await import('../dist/push-setup-core.js');
 const keys=await generatePushKeys();
 const request=webpush.generateRequestDetails({endpoint:'https://fcm.googleapis.com/test/setup',
  keys:{p256dh:keys.publicKey,auth:'AAAAAAAAAAAAAAAAAAAAAA'}},'setup test',
  {vapidDetails:{subject:'https://gameicom.github.io/EclipseSetup/',publicKey:keys.publicKey,privateKey:keys.privateKey}});
 assert.equal(request.headers['Content-Encoding'],'aes128gcm');
 const built=buildPushSetup('select 1;','__PUSH_SECRET__ __FUNCTION_URL__',keys,'https://xywqclfppwsiiydlniba.supabase.co');
 assert.ok(built.secrets.includes(keys.privateKey));assert.ok(!built.sql.includes(keys.privateKey));
 assert.ok(built.sql.includes(keys.dispatchSecret));
 assert.throws(()=>buildPushSetup('','',keys,'https://evil.test'),/Invalid/);
});
test('web setup health checks support CORS and modern server-only Supabase keys',async()=>{
 const values={ECLIPSE_PUSH_SECRET:'secret',SUPABASE_URL:'https://test.supabase.co',
 SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_serveronly'}),ECLIPSE_VAPID_PUBLIC_KEY:'public',ECLIPSE_VAPID_PRIVATE_KEY:'private'};
 const handler=createPushHandler({env:key=>values[key],generateRequestDetails:()=>({}),fetchImpl:async(url,options)=>{
  assert.equal(options.headers.apikey,'sb_secret_serveronly');assert.equal(options.headers.Authorization,undefined);
  return Response.json({public_key:'public'});
 }});
 const origin='https://gameicom.github.io';
 const preflight=await handler(new Request('https://test/push',{method:'OPTIONS',headers:{Origin:origin}}));
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),origin);
 assert.equal((await handler(new Request('https://test/push',{method:'OPTIONS',headers:{Origin:'https://evil.test'}}))).status,403);
 const response=await handler(new Request('https://test/push',{method:'POST',headers:{Origin:origin,Authorization:'Bearer secret'},body:'{"health":true}'}));
 assert.equal(response.status,200);assert.equal((await response.json()).ready,true);
});
