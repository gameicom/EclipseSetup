const DEVICE_KEY = 'eclipse-boss-timer.push.v1';
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export function decodePublicKey(value) {
  const raw = atob(value.replaceAll('-','+').replaceAll('_','/'));
  return Uint8Array.from(raw,character=>character.charCodeAt(0));
}
export class PushAlerts {
  constructor(client, onChange = () => {}) {
    this.client=client; this.onChange=onChange; this.enabled=false; this.busy=false;
    this.ready=false; this.registration=null; this.info=null; this.device=null;
    this.message='푸시 알림 준비 상태를 확인하고 있습니다.';
  }
  emit(message) {if(message) this.message=message; this.onChange(this);}
  async rpc(name,args={}) {
    const {data,error}=await this.client.rpc(name,args);
    if(error) {
      const messages={WAIT_ONE_MINUTE:'테스트 전송은 1분에 한 번 가능합니다. 잠시 후 다시 눌러 주세요.',
        PUSH_TIMER_UNAVAILABLE:'공동 보스 시간을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        PUSH_NOT_CONFIGURED:'푸시 서버 설정을 먼저 완료해 주세요.',
        PUSH_ACCESS_DENIED:'이 기기의 푸시 등록을 확인할 수 없습니다. 푸시를 껐다가 다시 켜 주세요.'};
      throw new Error(messages[error.message] || '푸시 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    return data;
  }
  supported() {
    return globalThis.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;
  }
  async init() {
    if(!this.supported()) {this.emit('이 브라우저에서는 푸시를 사용할 수 없습니다. iPhone은 Safari에서 홈 화면에 추가한 뒤 실행해 주세요.'); return;}
    try {
      const stored=localStorage.getItem(DEVICE_KEY);
      if(stored) { const value=JSON.parse(stored); if(value?.id && /^[\w-]{43}$/.test(value.token)) this.device=value; }
    } catch {}
    try {
      this.info=await this.rpc('eclipse_push_info');
      this.ready=!!this.info?.enabled && !!this.info?.public_key;
      if(!this.ready) {this.emit('푸시 서버 설정이 아직 완료되지 않았습니다. 현재 알림음은 탭에서만 재생됩니다.'); return;}
      this.registration=await navigator.serviceWorker.register(new URL('./sw.js',import.meta.url),{scope:new URL('./',import.meta.url).pathname,updateViaCache:'none'});
      await this.waitForWorker();
      const subscription=await this.registration.pushManager.getSubscription();
      if(subscription && this.device && Notification.permission==='granted') {
        this.enabled=await this.rpc('eclipse_push_status',{p_device:this.device.id,p_token:this.device.token});
        if(this.enabled) await this.save(subscription);
      }
      this.emit(this.enabled ? '이 기기로 리젠 푸시를 받습니다. 보통 리젠 후 1분 이내에 발송합니다.' : Notification.permission==='denied' ? '알림이 차단되어 있습니다. 브라우저 사이트 설정에서 알림을 허용해 주세요.' : '푸시를 켜면 탭을 닫아도 리젠 알림을 받을 수 있습니다.');
    } catch {this.ready=false;this.emit('푸시 서버 설정을 확인할 수 없습니다. 서버 활성화 후 새로고침해 주세요.');}
  }
  async waitForWorker() {
    for(let attempt=0;!this.registration.active && attempt<100;attempt++) await sleep(100);
    if(!this.registration.active) throw new Error('알림 기능을 준비 중입니다. 잠시 후 새로고침해 주세요.');
  }
  async save(subscription) {
    await this.rpc('eclipse_push_save',{p_device:this.device.id,p_token:this.device.token,p_subscription:subscription.toJSON()});
  }
  async enable() {
    if(!this.ready) throw new Error(this.message);
    // Request directly in the click handler, before any other asynchronous operation.
    const permission=await Notification.requestPermission();
    if(permission!=='granted') throw new Error('브라우저에서 알림을 허용해야 푸시를 받을 수 있습니다.');
    const newDevice=!this.device;
    if(!this.device) {
      const bytes=crypto.getRandomValues(new Uint8Array(32));
      const token=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
      const candidate={id:crypto.randomUUID(),token};
      localStorage.setItem(DEVICE_KEY,JSON.stringify(candidate));
      this.device=candidate;
    }
    await this.waitForWorker();
    let subscription=await this.registration.pushManager.getSubscription();
    if(subscription && newDevice) {
      if(!await subscription.unsubscribe()) throw new Error('이전 기기의 알림 등록을 해제하지 못했습니다.');
      subscription=null;
    }
    const publicKey=decodePublicKey(this.info.public_key);
    if(subscription) {
      const oldKey=new Uint8Array(subscription.options.applicationServerKey || []);
      if(oldKey.length!==publicKey.length || oldKey.some((value,index)=>value!==publicKey[index])) {
        if(!await subscription.unsubscribe()) throw new Error('이전 알림 등록을 해제하지 못했습니다.');
        subscription=null;
      }
    }
    const existing=!!subscription;
    subscription ||= await this.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:publicKey});
    try {await this.save(subscription);}
    catch(error) {if(!existing) await subscription.unsubscribe().catch(()=>{});throw error;}
    this.enabled=true; this.emit('푸시를 켰습니다. 이 기기에서 사이트를 닫아도 서버가 리젠 알림을 보냅니다.');
  }
  async disable() {
    // Remove the server registration first, so a failed request cannot pretend it is off.
    if(this.device) await this.rpc('eclipse_push_remove',{p_device:this.device.id,p_token:this.device.token});
    const subscription=await this.registration?.pushManager.getSubscription();
    if(subscription) await subscription.unsubscribe().catch(()=>{});
    this.enabled=false; this.emit('이 기기의 리젠 푸시를 껐습니다.');
  }
  async test() {
    if(!this.enabled || !this.device) throw new Error('먼저 이 기기의 푸시를 켜 주세요.');
    await this.rpc('eclipse_push_test',{p_device:this.device.id,p_token:this.device.token});
    this.emit('가장 가까운 보스의 테스트 푸시를 요청했습니다. 이 기기로 보통 1분 이내에 도착합니다.');
  }
}
