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
 await db.exec("reset role; truncate public.eclipse_push_subscriptions cascade; update public.eclipse_push_config set enabled=true,public_key='test-key',last_checked=clock_timestamp()-interval '90 seconds',broadcast_requested_at=null where id=1;");
 const now=Date.now();
 const bosses=[40,50,60,70,75,80].map((level,index)=>({level,interval_seconds:28800,anchor_kst:kstISO(now+(index?86400000:140000))}));
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 await role('anon');
});
async function seeded() {
 await save(A);await save(B,other);
 await db.exec("reset role; update public.eclipse_push_subscriptions set created_at=clock_timestamp()-interval '1 day';");
 await role('service_role');
}
test('public visitors cannot read private endpoints or trigger delivery',async()=>{
 const info=await run('eclipse_push_info');assert.equal(info.enabled,true);assert.equal(info.test_audience,'all');
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
test('respawns that have passed are never replayed even after a long outage',async()=>{
 await save();
 await db.exec("reset role; update public.eclipse_push_subscriptions set created_at=clock_timestamp()-interval '1 day'; update public.eclipse_push_config set last_checked=clock_timestamp()-interval '1 day';");
 await db.query("update public.eclipse_timer_state set bosses=jsonb_set(bosses,'{0,anchor_kst}',to_jsonb($1::text))",[kstISO(Date.now()-600000)]);
 await role('service_role');
 assert.equal(await run('eclipse_push_enqueue'),0);
});
test('test delivery reaches all subscribers with one shared cooldown and expired endpoints are removed',async()=>{
 await save();await save(B,other);
 await run('eclipse_push_test',[A,token]);
 await assert.rejects(run('eclipse_push_test',[A,token]),/WAIT_ONE_MINUTE/);
 await assert.rejects(run('eclipse_push_test',[B,other]),/WAIT_ONE_MINUTE/);
 await role('service_role');
 const jobs=await run('eclipse_push_claim');
 assert.equal(jobs.length,2);
 assert.deepEqual(jobs.map(job=>job.subscription.endpoint).sort(),[sub(A).endpoint,sub(B).endpoint].sort());
 assert.deepEqual(jobs[0].payload,jobs[1].payload);
 await run('eclipse_push_finish',[jobs.find(job=>job.subscription.endpoint===sub(A).endpoint).id,'gone']);
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
test('push migration preserves device registrations, shared times and the broadcast cooldown',async()=>{
 await save();await run('eclipse_push_test',[A,token]);
 const before=(await db.query('select bosses from public.eclipse_timer_state')).rows[0].bosses;
 await db.exec('reset role;');
 await db.exec(await readFile(new URL('../supabase/push.sql',import.meta.url),'utf8'));
 await role('anon');
 assert.equal(await run('eclipse_push_status',[A,token]),true);
 assert.deepEqual((await db.query('select bosses from public.eclipse_timer_state')).rows[0].bosses,before);
 await assert.rejects(run('eclipse_push_test',[A,token]),/WAIT_ONE_MINUTE/);
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

test('manual push sends the nearest repeating boss now without changing shared timers',async()=>{
 const now=Date.now();
 const bosses=[40,50,60,70,75,80].map(level=>({level,interval_seconds:28800,anchor_kst:kstISO(now+86400000)}));
 bosses[0].anchor_kst=kstISO(now-40000);
 bosses[4]={level:75,interval_seconds:300,anchor_kst:kstISO(now-120000)};
 await db.exec('reset role;');
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 await role('anon');await save();await save(B,other);
 assert.equal(await run('eclipse_push_test',[A,token]),true);
 assert.deepEqual((await db.query('select bosses from public.eclipse_timer_state')).rows[0].bosses,bosses);
 await role('service_role');
 const jobs=await run('eclipse_push_claim');
 assert.equal(jobs.length,2,'both test deliveries are ready immediately, not at the future boss time');
 assert.deepEqual(jobs.map(job=>job.subscription.endpoint).sort(),[sub(A).endpoint,sub(B).endpoint].sort());
 assert.deepEqual(jobs[0].payload,jobs[1].payload);
 assert.equal(jobs[0].payload.title,'[테스트] Lv.75 필드보스');
 const expected=kstISO(Date.parse(bosses[4].anchor_kst+'+09:00')+300000);
 assert.equal(jobs[0].payload.body,'다음 리젠 · '+expected.slice(5,10).replace('-','/')+' '+expected.slice(11)+' (한국시간)');
 assert.equal(jobs[0].payload.tag,'eclipse-push-test');
 assert.ok(jobs[0].payload.timestamp>=now && jobs[0].payload.timestamp<=Date.now());
});

test('manual push honors future anchors and chooses the lower level when times tie',async()=>{
 const now=Date.now(),first=kstISO(now+300000);
 const bosses=[40,50,60,70,75,80].map(level=>({level,interval_seconds:28800,anchor_kst:kstISO(now+86400000)}));
 bosses[4].anchor_kst=first;bosses[5].anchor_kst=first;
 await db.exec('reset role;');
 await db.query('update public.eclipse_timer_state set bosses=$1 where id=1',[JSON.stringify(bosses)]);
 await role('anon');await save();await run('eclipse_push_test',[A,token]);
 await role('service_role');const [job]=await run('eclipse_push_claim');
 assert.equal(job.payload.title,'[테스트] Lv.75 필드보스');
 assert.equal(job.payload.body,'다음 리젠 · '+first.slice(5,10).replace('-','/')+' '+first.slice(11)+' (한국시간)');
});

test('manual push selects shared edits made after the device subscribed',async()=>{
 await save();
 const changed=kstISO(Date.now()+120000);
 await db.exec('reset role;');
 await db.query("update public.eclipse_timer_state set bosses=jsonb_set(bosses,'{5,anchor_kst}',to_jsonb($1::text)) where id=1",[changed]);
 await role('anon');await run('eclipse_push_test',[A,token]);
 await role('service_role');const [job]=await run('eclipse_push_claim');
 assert.equal(job.payload.title,'[테스트] Lv.80 필드보스');
 assert.ok(job.payload.body.includes(changed.slice(11)));
});

test('manual push rejects a disabled server without consuming the test allowance',async()=>{
 await save();
 await db.exec('reset role; update public.eclipse_push_config set enabled=false;');
 await role('anon');await assert.rejects(run('eclipse_push_test',[A,token]),/PUSH_NOT_CONFIGURED/);
 await db.exec('reset role; update public.eclipse_push_config set enabled=true;');
 await role('anon');assert.equal(await run('eclipse_push_test',[A,token]),true);
 await role('service_role');assert.equal((await run('eclipse_push_claim')).length,1);
});

test('opted-out devices are excluded from broadcasts and queued copies are removed on opt-out',async()=>{
 const C='cccccccc-cccc-4ccc-cccc-cccccccccccc',third='c'.repeat(43);
 await save();await save(B,other);await save(C,third);
 await run('eclipse_push_remove',[B,other]);
 await assert.rejects(run('eclipse_push_test',[B,other]),/PUSH_ACCESS_DENIED/);
 await run('eclipse_push_test',[A,token]);
 await run('eclipse_push_remove',[C,third]);
 await role('service_role');const jobs=await run('eclipse_push_claim');
 assert.equal(jobs.length,1);assert.equal(jobs[0].subscription.endpoint,sub(A).endpoint);
});

test('numbered secrets preserve keys and authenticate real Apple push encryption',async()=>{
 const vapid=webpush.generateVAPIDKeys(),receiver=createECDH('prime256v1');receiver.generateKeys();
 const subscription={endpoint:'https://web.push.apple.com/test/numbered',keys:{p256dh:receiver.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
 const dispatchSecret=randomBytes(32).toString('base64url');
 for(const withNames of [false,true]) {
  const value=(name,text)=>withNames?' '+name+'='+text+' ':text;
  const values={
   '1':value('ECLIPSE_VAPID_PUBLIC_KEY',vapid.publicKey),
   '2':value('ECLIPSE_VAPID_PRIVATE_KEY',vapid.privateKey),
   '3':value('ECLIPSE_PUSH_SECRET',dispatchSecret),
   SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-key'
  };
  let claimed=false,deliveries=0;const finished=[];
  const handler=createPushHandler({env:key=>values[key],generateRequestDetails:webpush.generateRequestDetails.bind(webpush),fetchImpl:async(url,options)=>{
   if(url.endsWith('/eclipse_push_info'))return Response.json({public_key:vapid.publicKey});
   if(url.endsWith('/eclipse_push_claim')){const jobs=claimed?[]:[{id:9,subscription,payload:{title:'Numbered key test',body:'Retain existing subscriptions'}}];claimed=true;return Response.json(jobs);}
   if(url.endsWith('/eclipse_push_finish')){finished.push(JSON.parse(options.body));return Response.json(true);}
   assert.equal(url,subscription.endpoint);deliveries++;
   assert.equal(options.headers['Content-Encoding'],'aes128gcm');
   assert.ok(!Buffer.from(options.body).includes(Buffer.from('Numbered key test')));
   return new Response(null,{status:201});
  }});
  const request=body=>new Request('https://test/push',{method:'POST',headers:{Authorization:'Bearer '+dispatchSecret},body:JSON.stringify(body)});
  assert.equal((await handler(new Request('https://test/push',{method:'POST',body:'{}'}))).status,401);
  assert.equal((await handler(request({health:true}))).status,200);
  assert.equal(deliveries,0,'health does not send a notification');
  const response=await handler(request({}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{sent:1,retry:0,removed:0,expired:0});
  assert.deepEqual(finished,[{p_id:9,p_result:'sent'}]);
 }
});

test('named secrets take precedence over numbered values and are not disclosed',async()=>{
 const vapid=webpush.generateVAPIDKeys(),legacy=webpush.generateVAPIDKeys();
 const values={ECLIPSE_PUSH_SECRET:'named-secret',ECLIPSE_VAPID_PUBLIC_KEY:vapid.publicKey,
  ECLIPSE_VAPID_PRIVATE_KEY:vapid.privateKey,'1':legacy.publicKey,'2':legacy.privateKey,'3':'old-secret',
  SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service-key'};
 const handler=createPushHandler({env:key=>values[key],generateRequestDetails:webpush.generateRequestDetails.bind(webpush),fetchImpl:async(url)=>{
  assert.ok(url.endsWith('/eclipse_push_info'));return Response.json({public_key:vapid.publicKey});
 }});
 const request=secret=>new Request('https://test/push',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({health:true})});
 assert.equal((await handler(request('old-secret'))).status,401);
 const response=await handler(request('named-secret'));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{ready:true});
});

test('dispatch expires late warnings and caps provider TTL at respawn',async()=>{
 let claimed=false,deliveries=0;const finished=[],lifetimes=[];
 const expires=new Date(Date.now()+60000).toISOString();
 const handler=createPushHandler({
  env:name=>({ECLIPSE_PUSH_SECRET:'secret',SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service',
   ECLIPSE_VAPID_PUBLIC_KEY:'public',ECLIPSE_VAPID_PRIVATE_KEY:'private'})[name],
  generateRequestDetails:(subscription,payload,options)=>{lifetimes.push(options.TTL);return {endpoint:subscription.endpoint,method:'POST',headers:{},body:'encrypted'};},
  fetchImpl:async(url,options)=>{
   if(url.endsWith('/eclipse_push_claim')){
    const list=claimed?[]:[
     {id:1,expires_at:new Date(Date.now()-1000).toISOString(),subscription:sub(A),payload:{}},
     {id:2,expires_at:expires,subscription:sub(B),payload:{}}];
    claimed=true;return Response.json(list);
   }
   if(url.endsWith('/eclipse_push_finish')){finished.push(JSON.parse(options.body));return Response.json(true);}
   deliveries++;return new Response(null,{status:201});
  }
 });
 const response=await handler(new Request('https://test/push',{method:'POST',headers:{Authorization:'Bearer secret'},body:'{}'}));
 assert.equal(response.status,200);assert.equal(deliveries,1);
 assert.ok(lifetimes[0]>0 && lifetimes[0]<=60);
 assert.ok(finished.some(result=>result.p_id===1 && result.p_result==='expired'));
 assert.deepEqual(await response.json(),{sent:1,retry:0,removed:0,expired:1});
});
