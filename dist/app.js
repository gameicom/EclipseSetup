import { LEVELS, STORAGE_KEY, defaultSettings, validateSettings, kstISO, parseKST, schedule, remainingText, intervalText, resetBosses, crossedOccurrences } from './core.js';
import { createSharedTimer } from './shared.js';
import { sharedConfig } from './shared-config.js';
const $ = id => document.getElementById(id);
let state = defaultSettings(), undoState = null, pendingImport = null, sortMode = 'level';
let previousTick = Date.now(), audioContext = null, toastTimeout, audioBusy = false;
const rowNodes = new Map();
const SOUND_KEY = 'eclipse-boss-timer.sound.v2';
let shared = null, hasShared = false, connectionPhase = 'connecting', editBase = null, importBase = null;
const timerNow = () => shared ? shared.now() : Date.now();
const sameBoss = (a,b) => a?.anchor_kst === b?.anchor_kst && a?.interval_seconds === b?.interval_seconds && a?.level === b?.level;
function showToast(message) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function writeSoundPreference() {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify({sound:state.sound}));
    $('storage-warning').hidden = true;
  } catch {
    $('storage-warning').textContent = '알림음 선택을 이 브라우저에 저장하지 못했습니다. 공동 보스 시간은 서버에 저장됩니다.';
    $('storage-warning').hidden = false;
  }
}
try {
  const saved = localStorage.getItem(SOUND_KEY) || localStorage.getItem(STORAGE_KEY);
  if(saved) state.sound = JSON.parse(saved).sound === true;
} catch { state.sound = false; }
function setSharedStatus({phase}) {
  connectionPhase = phase;
  const labels = {connecting:'서버 연결 중',connected:'실시간 연결',saving:'공동 저장 중',reconnecting:'연결 복구 중',error:'연결 실패',unconfigured:'공유 미연결'};
  $('connection-text').textContent = labels[phase] || '연결 확인 중';
  document.body.dataset.connection = phase;
  if(phase !== 'unconfigured') {
    $('shared-notice').hidden = phase === 'connected' || phase === 'saving';
    $('shared-notice').textContent = phase === 'connecting'
      ? '공동 타이머에 연결하고 있습니다. 연결이 완료되면 모두 같은 시간을 볼 수 있습니다.'
      : '공동 서버와의 연결을 확인하고 있습니다. 지금은 수정할 수 없으며, 표시된 시간은 마지막으로 확인한 설정입니다.';
  }
  $('save-state').textContent = phase === 'connected' ? '모두가 같은 타이머를 실시간 공유 중' : phase === 'saving' ? '공동 서버에 저장 중' : '공동 서버 연결 확인 필요';
  render(timerNow());
}
function acceptSharedSnapshot(snapshot, {previous,own}) {
  state.bosses = structuredClone(snapshot.bosses);
  hasShared = true;
  if(undoState && undoState.levels.some(level => !sameBoss(state.bosses.find(b=>b.level===level),undoState.base.find(b=>b.level===level)))) undoState = null;
  if(!own && $('edit-dialog').open && editBase) {
    const changed = [...$('edit-fields').querySelectorAll('fieldset')].some(row => {
      const level = Number(row.dataset.level);
      return !sameBoss(state.bosses.find(b=>b.level===level),editBase.find(b=>b.level===level));
    });
    if(changed) $('edit-error').textContent = '수정 중인 보스의 공동 시간이 변경되었습니다. 창을 닫고 최신 시간을 확인한 뒤 다시 설정해 주세요.';
  }
  previousTick = timerNow();
  const updated = formatWall(Date.parse(snapshot.updated_at));
  $('shared-update').textContent = '마지막 공동 변경 · ' + updated.date + ' ' + updated.time + ' KST';
  render(previousTick);
  if(previous && !own) showToast('다른 사용자가 변경한 공동 시간을 반영했습니다.');
}
async function commitBosses({bosses,base=state.bosses,levels=LEVELS,action,message,remember=false}) {
  if(!shared?.ready) throw new Error('실시간 연결이 완료된 뒤 변경해 주세요.');
  const previous = structuredClone(base);
  const saved = await shared.update({bosses,base,levels:[...levels],action});
  undoState = remember && levels.every(level => sameBoss(state.bosses.find(b=>b.level===level),saved.bosses.find(b=>b.level===level)))
    ? {bosses:previous,base:structuredClone(saved.bosses),levels:[...levels]} : null;
  previousTick = timerNow();
  render(previousTick);
  showToast(message);
  return true;
}
function formatWall(timestamp) {
  const text = kstISO(timestamp);
  return { date: text.slice(5, 10).replace('-', '/'), time: text.slice(11), year: text.slice(0, 10).replaceAll('-', '.') };
}
function makeRows() {
  for (const boss of state.bosses) {
    const row = document.createElement('div');
    row.className = 'timer-row timer-grid';
    row.setAttribute('role', 'row');
    row.dataset.level = boss.level;
    row.innerHTML = '<div class="boss-identity" role="cell"><span class="boss-emblem" aria-hidden="true">◆</span><div><strong>Lv.' + boss.level +
      '</strong><span class="boss-type">필드보스</span></div><span class="row-status"></span></div>' +
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
  const wall = formatWall(now);
  $('current-clock').textContent = wall.time;
  $('current-clock').dateTime = kstISO(now) + '+09:00';
  $('current-date').textContent = wall.year + ' · UTC+9';
  const ordered = schedule(state.bosses, now), nearest = ordered[0];
  $('next-level').textContent = !hasShared ? '공동 시간 확인 중' : ordered.filter(boss => boss.due === nearest.due).map(boss => 'Lv.' + boss.level).join(' · ');
  const nextWall = formatWall(nearest.due);
  $('next-at').textContent = !hasShared ? '서버 연결 후 리젠 시각이 표시됩니다' : nextWall.date + '  ' + nextWall.time + ' 리젠 예정';
  $('next-countdown').textContent = hasShared ? remainingText(nearest.remaining) : '--:--:--';
  $('next-status').textContent = !hasShared ? '공동 서버 확인 필요' : nearest.soon ? '5분 이내 · 리젠 임박' : '다음 리젠 대기 중';
  document.querySelector('.next-spawn').classList.toggle('soon', hasShared && nearest.soon);
  document.title = hasShared ? remainingText(nearest.remaining) + ' · Lv.' + nearest.level + ' | 이클립스 공동 타이머' : '이클립스 · 공동 타이머 연결';
  for (const boss of ordered) {
    const nodes = rowNodes.get(boss.level);
    nodes.interval.textContent = hasShared ? intervalText(boss.interval_seconds) : '—';
    nodes.remaining.textContent = hasShared ? remainingText(boss.remaining) : '--:--:--';
    nodes.row.classList.toggle('soon', hasShared && boss.soon);
    nodes.row.classList.toggle('nearest', hasShared && boss.due === nearest.due);
    nodes.status.textContent = !hasShared ? '' : boss.soon ? '임박' : boss.due === nearest.due ? 'NEXT' : '';
    if(hasShared) {
      setWall(nodes.next, boss.due);
      setWall(nodes.anchor, parseKST(boss.anchor_kst));
    } else { nodes.next.textContent = '—'; nodes.anchor.textContent = '—'; }
    nodes.progress.style.width = (hasShared ? boss.progress * 100 : 0) + '%';
  }
  const display = sortMode === 'next' ? ordered : [...ordered].sort((a, b) => a.level - b.level);
  const parent = $('boss-rows');
  display.forEach((boss, index) => {
    const node = rowNodes.get(boss.level).row;
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  });
  const editable = !!shared?.ready;
  for(const id of ['edit-all','reset-all','import-settings','confirm-reset','confirm-import']) $(id).disabled = !editable;
  $('export-settings').disabled = !hasShared;
  $('undo').disabled = !editable || !undoState;
  $('edit-form').querySelector('[type="submit"]').disabled = !editable;
  document.querySelectorAll('.row-edit,.row-reset').forEach(button => { button.disabled = !editable; });
  $('sound-toggle').setAttribute('aria-checked', String(state.sound));
  const needsActivation = state.sound && (!audioContext || audioContext.state !== 'running');
  $('audio-note').textContent = needsActivation
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
function playTone() {
  if (!audioContext || audioContext.state !== 'running') return;
  [659.25, 880, 1046.5].forEach((frequency, index) => {
    const start = audioContext.currentTime + index * 0.15;
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.36);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  });
}
function tick() {
  const now = timerNow(), crossed = hasShared && shared?.ready ? crossedOccurrences(state.bosses, previousTick, now) : [];
  if (crossed.length) {
    showToast(crossed.map(boss => 'Lv.' + boss.level).join(', ') + '의 설정된 리젠 시각입니다.');
    if (state.sound) playTone();
  }
  render(now);
  previousTick = now;
}
function openEditor(levels) {
  if(!shared?.ready) return;
  editBase = structuredClone(state.bosses);
  $('edit-title').textContent = levels.length === 1 ? 'Lv.' + levels[0] + ' 시간 설정' : '전체 리젠 시간 설정';
  $('edit-error').textContent = '';
  $('edit-fields').replaceChildren();
  for (const level of levels) {
    const boss = state.bosses.find(item => item.level === level), fieldset = document.createElement('fieldset');
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
    return await commitBosses({bosses:resetBosses(state.bosses,levels,timerNow()),levels,action:'reset',remember:true,
      message:levels.length === 6 ? '6개 보스의 공동 기준 시각을 초기화했습니다.' : 'Lv.' + levels[0] + '의 공동 기준 시각을 초기화했습니다.'});
  } catch(error) {showToast(error.message); return false;}
}
$('boss-rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if(!button) return;
  const level = Number(button.closest('[data-level]').dataset.level);
  if(button.dataset.action === 'edit') openEditor([level]); else void reset([level]);
});
$('edit-all').addEventListener('click', () => openEditor(LEVELS));
$('reset-all').addEventListener('click', () => $('confirm-dialog').showModal());
$('confirm-reset').addEventListener('click', async () => { if(await reset(LEVELS)) $('confirm-dialog').close(); });
$('undo').addEventListener('click', async () => {
  if(!undoState) return;
  try {await commitBosses({...undoState,action:'undo',message:'내 마지막 변경을 공동 타이머에서 되돌렸습니다.'});}
  catch(error) {showToast(error.message);}
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
  sortMode = button.dataset.sort;
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
    const enabled = !state.sound;
    if (enabled) { await enableAudio(); playTone(); }
    state.sound = enabled;
    writeSoundPreference();
    render();
    showToast(enabled ? '이 기기의 리젠 알림음을 켰습니다.' : '이 기기의 리젠 알림음을 껐습니다.');
  } catch (error) { showToast(error.message); }
  finally { audioBusy = false; }
});
$('test-sound').addEventListener('click', async () => {
  try { await enableAudio(); playTone(); render(); showToast('테스트 알림음을 재생했습니다.'); }
  catch (error) { showToast(error.message); }
});
$('export-settings').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'eclipse-boss-timer-' + kstISO(timerNow()).slice(0, 10) + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('설정 파일을 내보냈습니다.');
});
$('import-settings').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 128 * 1024) throw new Error('설정 파일은 128KB 이하여야 합니다.');
    pendingImport = validateSettings(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
    importBase = structuredClone(state.bosses);
    $('import-dialog').showModal();
  } catch (error) {
    pendingImport = null;
    showToast(error instanceof SyntaxError ? 'JSON 형식의 설정 파일을 선택해 주세요.' : error.message);
  } finally { event.target.value = ''; }
});
$('confirm-import').addEventListener('click', async () => {
  if(!pendingImport || !importBase) return;
  try {
    await commitBosses({bosses:pendingImport.bosses,base:importBase,action:'import',remember:true,message:'파일의 보스 시간을 공동 타이머에 적용했습니다.'});
    $('import-dialog').close();
  } catch(error) {showToast(error.message);}
});
$('import-dialog').addEventListener('close', () => {pendingImport = null; importBase = null;});
$('edit-dialog').addEventListener('close', () => {editBase = null;});
window.addEventListener('storage', event => {
  if(event.key !== SOUND_KEY || !event.newValue) return;
  try {state.sound = JSON.parse(event.newValue).sound === true; render();}
  catch {}
});
document.addEventListener('visibilitychange', () => {
  if(!document.hidden) {void shared?.refresh(); tick();}
});
window.addEventListener('online', () => {void shared?.refresh();});
window.addEventListener('beforeunload', () => {void shared?.stop();});
makeRows();
render();
setInterval(tick,200);
try {
  shared = createSharedTimer(sharedConfig,{onSnapshot:acceptSharedSnapshot,onStatus:setSharedStatus});
  void shared.start();
} catch(error) {
  setSharedStatus({phase:'unconfigured'});
  $('shared-notice').hidden = false;
  $('shared-notice').textContent = error.message;
}
