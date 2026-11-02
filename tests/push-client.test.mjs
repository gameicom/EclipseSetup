import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {PushAlerts,decodePublicKey} from '../dist/push.js';
const originals=new Map();
const publicKey=Buffer.from([4,...Array(64).fill(1)]).toString('base64url');
let calls,stored,registration,subscription,client,failSave,owned,permission;
function replace(name,value) {
 if(!originals.has(name))originals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
 Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
}
beforeEach(()=>{
 calls=[];stored=new Map();failSave=false;owned=true;permission='granted';
 const makeSubscription=()=>({options:{applicationServerKey:decodePublicKey(publicKey).buffer},
  toJSON:()=>({endpoint:'https://fcm.googleapis.com/test',keys:{p256dh:'B'.repeat(87),auth:'C'.repeat(22)}}),
  async unsubscribe(){calls.push('unsubscribe');subscription=null;return true;}});
 subscription=null;
 registration={active:{},pushManager:{async getSubscription(){return subscription;},async subscribe(){calls.push('subscribe');subscription=makeSubscription();return subscription;}}};
 replace('isSecureContext',true);replace('PushManager',function(){});
 replace('Notification',{permission:'granted',async requestPermission(){calls.push('permission');return permission;}});
 replace('navigator',{serviceWorker:{async register(){calls.push('register');return registration;}}});
 replace('localStorage',{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)});
 client={async rpc(name,args){
  calls.push(name);
  if(name==='eclipse_push_info')return {data:{enabled:true,public_key:publicKey},error:null};
  if(name==='eclipse_push_status')return {data:owned,error:null};
  if(name==='eclipse_push_save' && failSave)return {data:null,error:{message:'unavailable'}};
  if(name==='eclipse_push_save')owned=true;
  if(name==='eclipse_push_remove')owned=false;
  return {data:true,error:null};
 }};
});
afterEach(()=>{
 for(const [name,descriptor] of originals) {if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
 originals.clear();
});
test('push remains disabled until the real server is ready and never prompts on page load',async()=>{
 client.rpc=async()=>({data:{enabled:false,public_key:''}});
 const push=new PushAlerts(client);await push.init();
 assert.equal(push.ready,false);assert.equal(push.enabled,false);
 assert.deepEqual(calls,[]);
 await assert.rejects(push.enable(),/설정/);
});
test('enabling push requests consent, saves a private device token, and registers with the server',async()=>{
 const push=new PushAlerts(client);await push.init();calls=[];
 await push.enable();
 assert.equal(calls[0],'permission');assert.ok(calls.includes('eclipse_push_save'));
 assert.equal(push.enabled,true);
 const saved=JSON.parse([...stored.values()][0]);
 assert.equal(saved.token.length,43);assert.equal(saved.id,push.device.id);
 await push.test();assert.ok(calls.includes('eclipse_push_test'));
 await push.disable();assert.equal(push.enabled,false);assert.equal(owned,false);
});
test('permission denial and storage failure never register a background subscription',async()=>{
 const push=new PushAlerts(client);await push.init();permission='denied';
 await assert.rejects(push.enable(),/허용/);
 assert.ok(!calls.includes('subscribe'));
 permission='granted';localStorage.setItem=()=>{throw new Error('Storage unavailable');};
 await assert.rejects(push.enable(),/Storage unavailable/);
 assert.ok(!calls.includes('subscribe'));
});
test('failed server registration rolls back a new browser subscription',async()=>{
 const push=new PushAlerts(client);await push.init();failSave=true;
 await assert.rejects(push.enable(),/서버/);
 assert.equal(push.enabled,false);assert.equal(subscription,null);
});
test('an opted-out server subscription is not silently recreated on reload',async()=>{
 const first=new PushAlerts(client);await first.init();await first.enable();
 owned=false;calls=[];
 const reloaded=new PushAlerts(client);await reloaded.init();
 assert.equal(reloaded.enabled,false);assert.ok(!calls.includes('eclipse_push_save'));
});
test('cleared local storage replaces an old browser subscription before registering a new device',async()=>{
 const first=new PushAlerts(client);await first.init();await first.enable();
 stored.clear();calls=[];
 const second=new PushAlerts(client);await second.init();await second.enable();
 assert.ok(calls.indexOf('unsubscribe')<calls.indexOf('subscribe'));
 assert.notEqual(first.device.id,second.device.id);assert.equal(second.enabled,true);
});
test('service worker displays server alarms and notification clicks stay inside the timer site',async()=>{
 const listeners={},notifications=[],opened=[],scope='https://gameicom.github.io/EclipseSetup/';
 const self={registration:{scope,async showNotification(title,options){notifications.push({title,options});}},
  clients:{async matchAll(){return [];},async openWindow(url){opened.push(url);}},
  addEventListener:(name,callback)=>{listeners[name]=callback;}};
 runInNewContext(await readFile(new URL('../dist/sw.js',import.meta.url),'utf8'),{self,URL,Date});
 let work;
 listeners.push({data:{json:()=>({title:'Lv.40 리젠',body:'18:00',tag:'boss-40',url:'https://evil.test'})},waitUntil:value=>{work=value;}});
 await work;
 assert.equal(notifications[0].options.icon,scope+'assets/push-192.png');
 assert.equal(notifications[0].options.tag,'boss-40');
 listeners.notificationclick({notification:{close(){},data:{url:'https://evil.test'}},waitUntil:value=>{work=value;}});
 await work;assert.deepEqual(opened,[scope]);
});

test('test push requires this device to be enabled and reports throttling without false success',async()=>{
 const push=new PushAlerts(client);await push.init();calls=[];
 await assert.rejects(push.test(),/먼저/);assert.deepEqual(calls,[]);
 await push.enable();
 const before=push.message;
 client.rpc=async(name,args)=>{
  assert.equal(name,'eclipse_push_test');
  assert.deepEqual(args,{p_device:push.device.id,p_token:push.device.token});
  return {error:{message:'WAIT_ONE_MINUTE'}};
 };
 await assert.rejects(push.test(),/1분에 한 번/);
 assert.equal(push.message,before);
 client.rpc=async()=>({data:true,error:null});
 await push.test();assert.match(push.message,/가장 가까운 보스/);
});
