import { LEVELS, validateSettings } from './core.js';

export class ConflictError extends Error {
  constructor(levels) {
    super('다른 사용자가 ' + levels.map(level => 'Lv.' + level).join(', ') + '을 먼저 변경했습니다. 최신 시간을 확인한 뒤 다시 설정해 주세요.');
    this.name = 'ConflictError';
    this.levels = levels;
  }
}
export function validateConfiguration(config) {
  if (!config?.supabaseUrl || !config?.supabasePublishableKey) throw new Error('공동 타이머 서버 연결이 아직 설정되지 않았습니다. 현재는 실시간 공유가 작동하지 않습니다.');
  const url = new URL(config.supabaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('공동 서버 주소가 올바르지 않습니다.');
  const key = config.supabasePublishableKey.trim();
  let publicKey = key.startsWith('sb_publishable_');
  if (key.split('.').length === 3) {
    try {
      const body = key.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
      publicKey = JSON.parse(atob(body)).role === 'anon';
    } catch { publicKey = false; }
  }
  if (!publicKey) throw new Error('브라우저용 publishable 키 또는 anon 키가 필요합니다.');
  return { url: url.origin, key };
}
export function parseSnapshot(row) {
  const revision = Number(row?.revision);
  if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isFinite(Date.parse(row?.updated_at))) throw new Error('공동 시간 응답을 확인할 수 없습니다.');
  const settings = validateSettings({version:1,timezone:'Asia/Seoul',bosses:row.bosses});
  return { ...row, bosses:settings.bosses, revision };
}
export class SharedTimer {
  constructor({ client, clientId = crypto.randomUUID(), onSnapshot = () => {}, onStatus = () => {}, now = Date.now, refreshInterval = 3600000 }) {
    this.client = client;
    this.clientId = clientId;
    this.onSnapshot = onSnapshot;
    this.onStatus = onStatus;
    this.clock = now;
    this.refreshInterval = refreshInterval;
    this.snapshot = null;
    this.offset = 0;
    this.live = false;
    this.healthy = false;
    this.saving = false;
    this.stopped = false;
    this.refreshTask = null;
    this.attemptedRead = false;
  }
  get ready() { return this.live && this.healthy && !!this.snapshot && !this.saving; }
  now() { return this.clock() + this.offset; }
  emitStatus() {
    if (!this.stopped) this.onStatus({phase:this.saving ? 'saving' : this.ready ? 'connected' : this.snapshot ? 'reconnecting' : this.attemptedRead ? 'error' : 'connecting', snapshot:this.snapshot});
  }
  accept(row, origin) {
    const next = parseSnapshot(row);
    if (!this.snapshot || next.revision > this.snapshot.revision) {
      const previous = this.snapshot;
      this.snapshot = next;
      this.onSnapshot(next, {origin,previous,own:next.client_id === this.clientId});
    }
    return this.snapshot;
  }
  readClock(serverNow, before) {
    const server = Date.parse(serverNow), after = this.clock();
    if (Number.isFinite(server) && after >= before && after - before < 10000) this.offset = server - (before + after) / 2;
  }
  async start() {
    this.channel = this.client.channel('eclipse-shared-timer-v1')
      .on('postgres_changes', {event:'UPDATE',schema:'public',table:'eclipse_timer_state',filter:'id=eq.1'}, event => {
        try { this.accept(event.new, 'realtime'); }
        catch { this.healthy = false; this.emitStatus(); }
      }).subscribe(status => {
        if(this.stopped) return;
        this.live = status === 'SUBSCRIBED';
        if (!this.live) this.healthy = false;
        this.emitStatus();
        if(this.live) void this.refresh();
      });
    this.emitStatus();
    if (this.refreshInterval > 0) this.interval = setInterval(() => { void this.refresh(); }, this.refreshInterval);
    await this.refresh();
    return this;
  }
  async refresh() {
    if(this.stopped) return;
    if(this.refreshTask) return this.refreshTask;
    this.refreshTask = this.performRefresh();
    try { return await this.refreshTask; }
    finally { this.refreshTask = null; }
  }
  async performRefresh() {
    this.attemptedRead = true;
    const before = this.clock();
    try {
      const {data,error} = await this.client.rpc('eclipse_read_timers');
      if(error || !data?.snapshot) throw new Error('Shared read failed');
      this.readClock(data.server_now,before);
      this.accept(data.snapshot,'read');
      this.healthy = true;
    } catch {
      this.healthy = false;
    }
    this.emitStatus();
  }
  async update({ bosses, base, levels, action }) {
    if(!this.ready) throw new Error('실시간 연결이 복구된 뒤 변경해 주세요. 아직 공동 설정은 저장되지 않았습니다.');
    const clean = value => validateSettings({version:1,timezone:'Asia/Seoul',bosses:value}).bosses;
    const proposed = clean(bosses), expected = clean(base);
    if(!Array.isArray(levels) || levels.length < 1 || new Set(levels).size !== levels.length || !levels.every(level => LEVELS.includes(level))) throw new Error('변경할 보스 목록이 올바르지 않습니다.');
    if(!['edit','reset','import','undo'].includes(action)) throw new Error('지원하지 않는 변경입니다.');
    this.saving = true;
    this.emitStatus();
    const before = this.clock();
    try {
      const {data,error} = await this.client.rpc('eclipse_update_timers', {
        p_bosses:proposed, p_base:expected, p_levels:levels, p_action:action, p_client_id:this.clientId
      });
      if(error || !data?.snapshot || !['ok','conflict'].includes(data.status)) throw new Error('Save response unavailable');
      this.readClock(data.server_now,before);
      this.accept(data.snapshot,'write');
      if(data.status === 'conflict') throw new ConflictError(data.conflicting_levels || levels);
      return parseSnapshot(data.snapshot);
    } catch(error) {
      if(error instanceof ConflictError) throw error;
      this.healthy = false;
      await this.refresh();
      throw new Error('저장 응답을 확인하지 못했습니다. 표시된 최신 공동 시간을 확인해 주세요.');
    } finally {
      this.saving = false;
      this.emitStatus();
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.interval);
    if(this.channel) await this.client.removeChannel(this.channel);
  }
}
async function timedFetch(input, init = {}) {
  const controller = new AbortController();
  const relay = () => controller.abort();
  if(init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener('abort',relay,{once:true});
  const timer = setTimeout(relay,10000);
  try { return await fetch(input,{...init,signal:controller.signal}); }
  finally { clearTimeout(timer); init.signal?.removeEventListener('abort',relay); }
}
export function createSharedTimer(config, callbacks) {
  const {url,key} = validateConfiguration(config);
  if(!globalThis.supabase?.createClient) throw new Error('공동 연결 파일을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
  const client = globalThis.supabase.createClient(url,key,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:timedFetch}
  });
  return new SharedTimer({client,...callbacks});
}
