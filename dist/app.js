import { STORAGE_KEY, defaultSettings, validateSettings, kstISO, parseKST, schedule, remainingText, intervalText, resetBosses, crossedOccurrences } from './core.js';
import { defaultNamedSettings, validateNamedSettings, MAX_NAMED_BOSSES } from './named.js';
import { createSharedTimer } from './shared.js';
import { sharedConfig } from './shared-config.js';
import { DEFAULT_VOLUME, normalizeVolume, readAudioPreference, playAlarm } from './audio.js';
import { PushAlerts } from './push.js';
const $ = id => document.getElementById(id);
const timers=Object.fromEntries([['field','필보',defaultSettings()],['named','네임드',defaultNamedSettings()]].map(([id,label,state])=>[id,{id,label,state,undoState:null,sortMode:'level',previousTick:Date.now(),shared:null,hasShared:false,connectionPhase:'connecting'}]));
let active=timers.field, pendingImport=null, audioContext=null, toastTimeout, audioBusy=false, soundEnabled=false;
let rowSignature='', importContext=null;
const rowNodes = new Map();
const SOUND_KEY = 'eclipse-boss-timer.sound.v2';
let volume = DEFAULT_VOLUME, pushAlerts = null;
let editBase=null, importBase=null;
const timerNow = (context=active) => context.shared ? context.shared.now() : Date.now();
const levelsFor = (context=active) => context.state.bosses.map(b=>b.level);
const sameBoss = (a,b) => a?.anchor_kst === b?.anchor_kst && a?.interval_seconds === b?.interval_seconds && a?.level === b?.level;
function showToast(message) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function writeSoundPreference() {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify({sound:soundEnabled,volume}));
    $('storage-warning').hidden = true;
  } catch {
    $('storage-warning').textContent = '알림음 선택을 이 브라우저에 저장하지 못했습니다. 공동 보스 시간은 서버에 저장됩니다.';
    $('storage-warning').hidden = false;
  }
}
try {
  const saved = localStorage.getItem(SOUND_KEY) || localStorage.getItem(STORAGE_KEY);
  if(saved) {const preference=readAudioPreference(JSON.parse(saved)); soundEnabled=preference.sound; volume=preference.volume;}
} catch { soundEnabled = false; }
function setSharedStatus(context,{phase}) {
  context.connectionPhase=phase;
  render();
}
function renderConnection() {
  const phase=active.connectionPhase;
  const labels={connecting:'서버 연결 중',connected:'실시간 연결',saving:'공동 저장 중',reconnecting:'연결 복구 중',error:'연결 실패',unconfigured:'설정 필요'};
  $('connection-text').textContent=active.label+' · '+(labels[phase]||'연결 확인 중');
  document.body.dataset.connection=phase;
  $('shared-notice').hidden=phase==='connected'||phase==='saving';
  $('shared-notice').textContent=active.configError || (phase==='unconfigured' && active.id==='named'
    ? '네임드 서버 설정이 필요합니다. 관리자가 네임드 업데이트 SQL을 실행한 뒤 새로고침해 주세요.'
    : phase==='connecting' ? active.label+' 공동 타이머에 연결하고 있습니다.'
    : '공동 서버와의 연결을 확인하고 있습니다. 지금은 수정할 수 없으며, 표시된 시간은 마지막으로 확인한 설정입니다.');
  $('named-setup-link').hidden=active.id!=='named'||phase!=='unconfigured';
  $('save-state').textContent=phase==='connected' ? active.label+' 시간을 모두가 실시간 공유 중 · 정기 확인 '+(active.id==='named'?'30분':'1시간')
    : phase==='saving' ? '공동 서버에 저장 중' : '공동 서버 연결 확인 필요';
  const updated=active.shared?.snapshot?.updated_at;
  const wall=updated ? formatWall(Date.parse(updated)) : null;
  $('shared-update').textContent=wall ? '마지막 공동 변경 · '+wall.date+' '+wall.time+' KST' : '보스 시간과 주기는 모든 사용자에게 함께 반영됩니다.';
}
function acceptSharedSnapshot(context,snapshot,{previous,own}) {
  context.state.bosses=structuredClone(snapshot.bosses);
  context.hasShared=true;
  if(context.undoState && context.undoState.levels.some(level=>!sameBoss(context.state.bosses.find(b=>b.level===level),context.undoState.base.find(b=>b.level===level)))) context.undoState=null;
  if(context===active && !own && $('edit-dialog').open && editBase) {
    const changed=[...$('edit-fields').querySelectorAll('fieldset')].some(row=>{
      const level=Number(row.dataset.level);
      return !sameBoss(context.state.bosses.find(b=>b.level===level),editBase.find(b=>b.level===level));
    });
    if(changed) $('edit-error').textContent='수정 중인 보스의 공동 시간이 변경되었습니다. 창을 닫고 최신 시간을 확인한 뒤 다시 설정해 주세요.';
  }
  context.previousTick=timerNow(context);
  render();
  if(previous && !own) showToast(context.label+' · 다른 사용자가 변경한 공동 시간을 반영했습니다.');
}
async function commitBosses({context=active,bosses,base=context.state.bosses,levels=levelsFor(context),action,message,remember=false}) {
  if(!context.shared?.ready) throw new Error('실시간 연결이 완료된 뒤 변경해 주세요.');
  const previous=structuredClone(base);
  const saved=await context.shared.update({bosses,base,levels:[...levels],action});
  context.undoState=remember && levels.every(level=>previous.some(b=>b.level===level) && sameBoss(context.state.bosses.find(b=>b.level===level),saved.bosses.find(b=>b.level===level)))
    ? {bosses:previous,base:structuredClone(saved.bosses),levels:[...levels]} : null;
  context.previousTick=timerNow(context);
  render();
  showToast(context.label+' · '+message);
  return true;
}
function formatWall(timestamp) {
  const text = kstISO(timestamp);
  return { date: text.slice(5, 10).replace('-', '/'), time: text.slice(11), year: text.slice(0, 10).replaceAll('-', '.') };
}
function makeRows() {
  const signature=active.id+':'+levelsFor().join(',');
  if(signature===rowSignature) return;
  rowSignature=signature;
  rowNodes.clear();
  $('boss-rows').replaceChildren();
  for (const boss of active.state.bosses) {
    const row = document.createElement('div');
    row.className = 'timer-row timer-grid';
    row.setAttribute('role', 'row');
    row.dataset.level = boss.level;
    row.innerHTML = '<div class="boss-identity" role="cell"><span class="boss-emblem" aria-hidden="true">◆</span><div><strong>Lv.' + boss.level +
      '</strong><span class="boss-type">' + (active.id==='named'?'네임드':'필드보스') + '</span></div><span class="row-status"></span></div>' +
      '<div class="interval-cell" role="cell"><span class="mobile-label">리젠 주기</span><span class="interval-value"></span></div>' +
      '<div class="remaining-cell" role="cell"><span class="mobile-label">남은 시간</span><strong class="remaining-value"></strong><div class="progress-track" aria-hidden="true"><span></span></div></div>' +
      '<div class="next-cell" role="cell"><span class="mobile-label">다음 리젠</span><time class="next-value"></time></div>' +
      '<div class="anchor-cell" role="cell"><span class="mobile-label">기준 시각</span><time class="anchor-value"></time></div>' +
      '<div class="row-actions" role="cell"><button class="row-edit" data-action="edit" aria-label="Lv.' + boss.level + ' 시간 설정">시간 설정</button><button class="row-reset" data-action="reset" aria-label="Lv.' + boss.level + ' 초기화" title="지금부터 한 주기 뒤로 초기화">↻</button></div>';
    rowNodes.set(boss.level, { row, interval: row.querySelector('.interval-value'), remaining: row.querySelector('.remaining-value'),
      next: row.querySelector('.next-value'), anchor: row.querySelector('.anchor-value'),
      progress: row.querySelector('.progress-track span'), status: row.querySelector('.row-status') });
    $('boss-rows').append(row);
  }
}
function setWall(node, timestamp) {
  const wall = formatWall(timestamp), value = wall.date + '  ' + wall.time;
  if (node.textContent !== value) node.textContent = value;
  node.dateTime = kstISO(timestamp) + '+09:00';
  node.title = wall.year + ' ' + wall.time + ' KST';
}
function render(now = timerNow()) {
  makeRows();
  renderConnection();
  const named=active.id==='named', count=active.state.bosses.length;
  document.body.dataset.group=active.id;
  $('page-title').textContent=named?'네임드 타이머':'필드보스 타이머';
  $('boss-heading').textContent=named?'네임드 타이머':'보스 타이머';
  $('boss-count').textContent=String(count);
  $('stat-count').textContent=String(count).padStart(2,'0');
  const levels=levelsFor();
  $('stat-range').textContent='Lv.'+Math.min(...levels)+' — Lv.'+Math.max(...levels);
  $('table-boss-type').textContent=named?'네임드':'필드보스';
  $('timer-table').setAttribute('aria-label',(named?'네임드':'필드보스')+' 리젠 시간');
  $('group-description').textContent=named?'기본 리젠 30분 · 변경 즉시 공유 · 정기 동기화 30분':'변경 즉시 공유 · 정기 동기화 1시간 · 리젠 3분 전 푸시';
  $('add-named').hidden=!named;
  $('add-named').disabled=!active.shared?.ready||count>=MAX_NAMED_BOSSES;
  $('confirm-reset-description').textContent='모든 사용자가 보는 '+active.label+' '+count+'개의 기준 시각을 현재 서버 시각으로 바꿉니다. 각 보스의 리젠 주기는 유지됩니다.';
  document.querySelectorAll('[data-sort]').forEach(button=>{
    button.classList.toggle('active',button.dataset.sort===active.sortMode);
    button.setAttribute('aria-pressed',String(button.dataset.sort===active.sortMode));
  });
  const wall = formatWall(now);
  $('current-clock').textContent = wall.time;
  $('current-clock').dateTime = kstISO(now) + '+09:00';
  $('current-date').textContent = wall.year + ' · UTC+9';
  const ordered = schedule(active.state.bosses, now), nearest = ordered[0];
  $('next-level').textContent = !active.hasShared ? '공동 시간 확인 중' : ordered.filter(boss => boss.due === nearest.due).map(boss => 'Lv.' + boss.level).join(' · ');
  const nextWall = formatWall(nearest.due);
  const field=timers.field, nextField=schedule(field.state.bosses,timerNow(field))[0], fieldWall=formatWall(nextField.due);
  const pushPreview=field.hasShared ? '필보 Lv.'+nextField.level+' · '+fieldWall.date+' '+fieldWall.time+' 리젠 예정 (한국시간)' : '필보 서버 연결 후 다음 보스가 표시됩니다.';
  if($('push-test-preview').textContent!==pushPreview) $('push-test-preview').textContent=pushPreview;
  $('next-at').textContent = !active.hasShared ? '서버 연결 후 리젠 시각이 표시됩니다' : nextWall.date + '  ' + nextWall.time + ' 리젠 예정';
  $('next-countdown').textContent = active.hasShared ? remainingText(nearest.remaining) : '--:--:--';
  $('next-status').textContent = !active.hasShared ? '공동 서버 확인 필요' : nearest.soon ? '5분 이내 · 리젠 임박' : '다음 리젠 대기 중';
  document.querySelector('.next-spawn').classList.toggle('soon', active.hasShared && nearest.soon);
  document.title = active.hasShared ? remainingText(nearest.remaining) + ' · Lv.' + nearest.level + ' | 이클립스 '+active.label+' 타이머' : '이클립스 · 공동 타이머 연결';
  for (const boss of ordered) {
    const nodes = rowNodes.get(boss.level);
    nodes.interval.textContent = active.hasShared ? intervalText(boss.interval_seconds) : '—';
    nodes.remaining.textContent = active.hasShared ? remainingText(boss.remaining) : '--:--:--';
    nodes.row.classList.toggle('soon', active.hasShared && boss.soon);
    nodes.row.classList.toggle('nearest', active.hasShared && boss.due === nearest.due);
    nodes.status.textContent = !active.hasShared ? '' : boss.soon ? '임박' : boss.due === nearest.due ? 'NEXT' : '';
    if(active.hasShared) {
      setWall(nodes.next, boss.due);
      setWall(nodes.anchor, parseKST(boss.anchor_kst));
    } else { nodes.next.textContent = '—'; nodes.anchor.textContent = '—'; }
    nodes.progress.style.width = (active.hasShared ? boss.progress * 100 : 0) + '%';
  }
  const display = active.sortMode === 'next' ? ordered : [...ordered].sort((a, b) => a.level - b.level);
  const parent = $('boss-rows');
  display.forEach((boss, index) => {
    const node = rowNodes.get(boss.level).row;
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  });
  const editable = !!active.shared?.ready;
  for(const id of ['edit-all','reset-all','import-settings','confirm-reset','confirm-import']) $(id).disabled = !editable;
  $('export-settings').disabled = !active.hasShared;
  $('undo').disabled = !editable || !active.undoState;
  $('edit-form').querySelector('[type="submit"]').disabled = !editable;
  document.querySelectorAll('.row-edit,.row-reset').forEach(button => { button.disabled = !editable; });
  $('sound-toggle').setAttribute('aria-checked', String(soundEnabled));
  $('sound-volume').value = String(volume);
  $('sound-volume').setAttribute('aria-valuetext', volume === 0 ? '0% · 음소거' : volume + '%');
  $('sound-volume-value').value = volume + '%';
  const needsActivation = soundEnabled && volume > 0 && (!audioContext || audioContext.state !== 'running');
  $('audio-note').textContent = soundEnabled && volume === 0 ? '현재 볼륨은 0%입니다. 알림음을 들으려면 볼륨을 올려 주세요.' : needsActivation
    ? '알림음이 켜져 있습니다. ‘소리 테스트’를 눌러 이 탭에서 오디오를 활성화해 주세요.'
    : '알림음은 이 페이지가 열려 있을 때 작동합니다. 브라우저가 절전 상태가 되면 알림이 늦어질 수 있습니다.';
  $('audio-note').classList.toggle('needs-activation', needsActivation);
}
async function enableAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) throw new Error('이 브라우저는 알림음을 지원하지 않습니다.');
  if (!audioContext || audioContext.state === 'closed') audioContext = new Audio();
  if (audioContext.state !== 'running') await audioContext.resume();
  if (audioContext.state !== 'running') throw new Error('브라우저의 소리 허용 설정을 확인해 주세요.');
}
function playTone() { return playAlarm(audioContext,volume); }
function tick() {
  const alarms=[];
  for(const context of Object.values(timers)) {
    const now=timerNow(context);
    const crossed=context.hasShared && context.shared?.ready ? crossedOccurrences(context.state.bosses,context.previousTick,now) : [];
    if(crossed.length) alarms.push(context.label+' '+crossed.map(b=>'Lv.'+b.level).join(', '));
    context.previousTick=now;
  }
  if(alarms.length) {
    showToast(alarms.join(' / ')+'의 설정된 리젠 시각입니다.');
    if(soundEnabled) playTone();
  }
  render();
}
function switchGroup(id,focus=false) {
  if(!timers[id]) return;
  active=timers[id];
  document.querySelectorAll('[data-group]').forEach(button=>{
    const selected=button.dataset.group===id;
    button.setAttribute('aria-selected',String(selected));
    button.tabIndex=selected?0:-1;
    if(selected && focus) button.focus();
  });
  $('timer-panel').setAttribute('aria-labelledby','tab-'+id);
  render();
}
document.querySelectorAll('[data-group]').forEach(button=>{
  button.addEventListener('click',()=>switchGroup(button.dataset.group));
  button.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    switchGroup(event.key==='Home'?'field':event.key==='End'?'named':active.id==='field'?'named':'field',true);
  });
});
function openEditor(levels) {
  if(!active.shared?.ready) return;
  editBase = structuredClone(active.state.bosses);
  $('edit-title').textContent = levels.length === 1 ? 'Lv.' + levels[0] + ' 시간 설정' : '전체 리젠 시간 설정';
  $('edit-error').textContent = '';
  $('edit-fields').replaceChildren();
  for (const level of levels) {
    const boss = active.state.bosses.find(item => item.level === level), fieldset = document.createElement('fieldset');
    fieldset.className = 'edit-row';
    fieldset.dataset.level = level;
    fieldset.innerHTML = '<legend>Lv.' + level + '</legend><div class="edit-row-inputs">' +
      '<label class="date-field">기준 날짜<input type="date" name="date" min="2000-01-01" max="2090-12-31" required value="' + boss.anchor_kst.slice(0, 10) + '" aria-label="Lv.' + level + ' 기준 날짜"></label>' +
      '<label class="time-field">기준 시간<input type="time" name="time" step="1" required value="' + boss.anchor_kst.slice(11) + '" aria-label="Lv.' + level + ' 기준 시간"></label>' +
      '<div class="interval-fields"><span>리젠 간격</span><div>' +
      '<label><input type="number" name="hours" min="0" max="999" step="1" required value="' + Math.floor(boss.interval_seconds / 3600) + '" aria-label="Lv.' + level + ' 리젠 간격 시간">시간</label>' +
      '<label><input type="number" name="minutes" min="0" max="59" step="1" required value="' + Math.floor(boss.interval_seconds / 60) % 60 + '" aria-label="Lv.' + level + ' 리젠 간격 분">분</label>' +
      '<label><input type="number" name="seconds" min="0" max="59" step="1" required value="' + boss.interval_seconds % 60 + '" aria-label="Lv.' + level + ' 리젠 간격 초">초</label></div></div>' +
      '<button type="button" class="button secondary fill-now" aria-label="Lv.' + level + ' 현재 시각 입력">현재 시각</button></div>';
    $('edit-fields').append(fieldset);
  }
  $('edit-dialog').showModal();
}
async function reset(levels) {
  try {
    return await commitBosses({bosses:resetBosses(active.state.bosses,levels,timerNow()),levels,action:'reset',remember:true,
      message:levels.length > 1 ? levels.length+'개 보스의 공동 기준 시각을 초기화했습니다.' : 'Lv.' + levels[0] + '의 공동 기준 시각을 초기화했습니다.'});
  } catch(error) {showToast(error.message); return false;}
}
$('boss-rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if(!button) return;
  const level = Number(button.closest('[data-level]').dataset.level);
  if(button.dataset.action === 'edit') openEditor([level]); else void reset([level]);
});
$('edit-all').addEventListener('click', () => openEditor(levelsFor()));
$('reset-all').addEventListener('click', () => $('confirm-dialog').showModal());
$('confirm-reset').addEventListener('click', async () => { if(await reset(levelsFor())) $('confirm-dialog').close(); });
$('undo').addEventListener('click', async () => {
  if(!active.undoState) return;
  try {await commitBosses({...active.undoState,action:'undo',message:'내 마지막 변경을 공동 타이머에서 되돌렸습니다.'});}
  catch(error) {showToast(error.message);}
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
  active.sortMode = button.dataset.sort;
  document.querySelectorAll('[data-sort]').forEach(item => {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  });
  render();
}));
$('edit-fields').addEventListener('click', event => {
  const button = event.target.closest('.fill-now');
  if (!button) return;
  const row = button.closest('fieldset'), now = kstISO(timerNow());
  row.querySelector('[name="date"]').value = now.slice(0, 10);
  row.querySelector('[name="time"]').value = now.slice(11);
});
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const bosses = structuredClone(editBase);
    for (const row of $('edit-fields').querySelectorAll('fieldset')) {
      const level = Number(row.dataset.level);
      const get = name => row.querySelector('[name="' + name + '"]').value;
      const time = get('time').length === 5 ? get('time') + ':00' : get('time');
      const interval = ['hours', 'minutes', 'seconds'].map(name => get(name));
      if (!interval.every(value => /^\d+$/.test(value))) throw new Error('리젠 간격은 0 이상의 정수로 입력해 주세요.');
      const [hours, minutes, seconds] = interval.map(Number);
      if (hours > 999 || minutes > 59 || seconds > 59) throw new Error('시간은 0~999, 분과 초는 0~59로 입력해 주세요.');
      const boss = bosses.find(item => item.level === level);
      boss.anchor_kst = get('date') + 'T' + time;
      boss.interval_seconds = hours * 3600 + minutes * 60 + seconds;
    }
    await commitBosses({bosses,base:editBase,levels:[...$('edit-fields').querySelectorAll('fieldset')].map(row=>Number(row.dataset.level)),action:'edit',message:'공동 시간 설정을 저장했습니다. 모든 접속자에게 반영됩니다.'});
    $('edit-dialog').close();
  } catch (error) { $('edit-error').textContent = error.message; }
});
$('sound-toggle').addEventListener('click', async () => {
  if (audioBusy) return;
  audioBusy = true;
  try {
    const enabled = !soundEnabled;
    if (enabled) { await enableAudio(); playTone(); }
    soundEnabled = enabled;
    writeSoundPreference();
    render();
    showToast(enabled ? '이 기기의 리젠 알림음을 켰습니다.' : '이 기기의 리젠 알림음을 껐습니다.');
  } catch (error) { showToast(error.message); }
  finally { audioBusy = false; }
});
$('test-sound').addEventListener('click', async () => {
  try { await enableAudio(); const played=playTone(); render(); showToast(played ? '테스트 알림음을 재생했습니다.' : '볼륨이 0%입니다. 슬라이더로 볼륨을 올려 주세요.'); }
  catch (error) { showToast(error.message); }
});
$('sound-volume').addEventListener('input', event => {
  volume = normalizeVolume(Number(event.target.value));
  writeSoundPreference();
  render();
});
$('export-settings').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({...active.state,sound:soundEnabled}, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'eclipse-'+active.id+'-timer-' + kstISO(timerNow()).slice(0, 10) + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('설정 파일을 내보냈습니다.');
});
$('import-settings').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const context=active;
  try {
    if (file.size > 128 * 1024) throw new Error('설정 파일은 128KB 이하여야 합니다.');
    const input=JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    pendingImport=context.id==='named'?validateNamedSettings(input):validateSettings(input);
    importContext=context;
    importBase=structuredClone(context.state.bosses);
    $('import-description').textContent=context.label+' 파일의 '+pendingImport.bosses.length+'개 보스 시간을 공동 타이머에 적용합니다.'+(context.id==='named'?' 파일에 없는 기존 네임드는 유지합니다.':'');
    $('import-note').textContent=context.id==='named'?'네임드 탭에서 내보낸 설정 파일을 사용하세요. 새 레벨도 함께 추가됩니다.':'Windows 프로그램의 settings.json도 불러올 수 있습니다.';
    $('import-dialog').showModal();
  } catch (error) {
    pendingImport = null;
    showToast(error instanceof SyntaxError ? 'JSON 형식의 설정 파일을 선택해 주세요.' : error.message);
  } finally { event.target.value = ''; }
});
$('confirm-import').addEventListener('click', async () => {
  if(!pendingImport || !importBase) return;
  try {
    await commitBosses({context:importContext,bosses:pendingImport.bosses,base:importBase,levels:pendingImport.bosses.map(b=>b.level),action:'import',remember:true,message:'파일의 보스 시간을 공동 타이머에 적용했습니다.'});
    $('import-dialog').close();
  } catch(error) {showToast(error.message);}
});
$('import-dialog').addEventListener('close', () => {pendingImport = null; importBase = null; importContext=null;});
$('edit-dialog').addEventListener('close', () => {editBase = null;});
window.addEventListener('storage', event => {
  if(event.key !== SOUND_KEY || !event.newValue) return;
  try {const preference=readAudioPreference(JSON.parse(event.newValue)); soundEnabled=preference.sound; volume=preference.volume; render();}
  catch {}
});
document.addEventListener('visibilitychange', () => {
  if(!document.hidden) tick();
});
window.addEventListener('online',()=>{for(const context of Object.values(timers)) void context.shared?.refresh();});
window.addEventListener('beforeunload',()=>{for(const context of Object.values(timers)) void context.shared?.stop();});
makeRows();
render();
setInterval(tick,200);
try {
  for(const context of Object.values(timers)) {
    context.shared=createSharedTimer(sharedConfig,{group:context.id,client:timers.field.shared?.client,
      onSnapshot:(snapshot,meta)=>acceptSharedSnapshot(context,snapshot,meta),onStatus:status=>setSharedStatus(context,status)});
    void context.shared.start();
  }
  pushAlerts=new PushAlerts(timers.field.shared.client,renderPushStatus);
  void pushAlerts.init();
} catch(error) {
  for(const context of Object.values(timers)) if(!context.shared) {
    context.configError=error.message;
    setSharedStatus(context,{phase:'unconfigured'});
  }
}
$('add-named').addEventListener('click',()=>{
  if(active.id!=='named'||!active.shared?.ready) return;
  const used=new Set(levelsFor());
  let suggestion=Math.max(...used)+1;
  if(suggestion>999) suggestion=Array.from({length:999},(_,i)=>i+1).find(level=>!used.has(level));
  const now=kstISO(timerNow());
  $('named-level').value=String(suggestion);
  $('named-date').value=now.slice(0,10);
  $('named-time').value=now.slice(11);
  $('add-error').textContent='';
  $('add-dialog').showModal();
});
$('add-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=$('add-submit');
  if(button.disabled) return;
  button.disabled=true;
  try {
    const context=timers.named, level=Number($('named-level').value), base=structuredClone(context.state.bosses);
    if(base.some(b=>b.level===level)) throw new Error('이미 등록된 네임드 레벨입니다.');
    const time=$('named-time').value;
    const item={level,interval_seconds:1800,anchor_kst:$('named-date').value+'T'+(time.length===5?time+':00':time)};
    const bosses=validateNamedSettings({version:1,kind:'named',bosses:[...base,item]}).bosses;
    await commitBosses({context,bosses,base,levels:[level],action:'add',message:'Lv.'+level+'을 30분 주기로 추가했습니다. 모든 접속자에게 공유됩니다.'});
    $('add-dialog').close();
  } catch(error) {$('add-error').textContent=error.message;}
  finally {button.disabled=false;}
});

function renderPushStatus(controller) {
  $('push-toggle').disabled=controller.busy || !controller.ready;
  $('push-toggle').setAttribute('aria-checked',String(controller.enabled));
  $('push-toggle-label').textContent=controller.enabled ? '푸시 켜짐' : '푸시 켜기';
  const broadcastReady=controller.info?.test_audience==='all';
  $('test-push').disabled=controller.busy || !controller.enabled || !broadcastReady;
  $('push-test-help').textContent=controller.ready && !broadcastReady
    ? '전체 전송을 사용하려면 관리자용 최초 설정에서 푸시 서버 업데이트 SQL을 적용한 뒤 새로고침해 주세요.'
    : '가장 가까운 필보의 예정 시간을 푸시를 켠 모든 기기에 보냅니다. 보통 1분 이내 도착하며, 전체 테스트 전송은 1분에 한 번 가능합니다.';
  $('test-push').textContent=controller.busy ? '처리 중…' : '전송';
  $('push-note').textContent=controller.message;
}
async function pushAction(action) {
  if(!pushAlerts || pushAlerts.busy) return;
  pushAlerts.busy=true; pushAlerts.emit();
  try {await action();}
  catch(error) {showToast(error.message);}
  finally {pushAlerts.busy=false;pushAlerts.emit();}
}
$('push-toggle').addEventListener('click',()=>pushAction(()=>pushAlerts.enabled?pushAlerts.disable():pushAlerts.enable()));
$('test-push').addEventListener('click',()=>pushAction(()=>pushAlerts.test()));
