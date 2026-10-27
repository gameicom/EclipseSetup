import { LEVELS, STORAGE_KEY, defaultSettings, validateSettings, kstISO, parseKST, schedule, remainingText, intervalText, resetBosses, crossedOccurrences } from './core.js';
const $ = id => document.getElementById(id);
let state = defaultSettings(), undoState = null, pendingImport = null, sortMode = 'level';
let previousTick = Date.now(), audioContext = null, toastTimeout, audioBusy = false;
const rowNodes = new Map();
function showToast(message) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function storageWarning(message) {
  $('storage-warning').textContent = message;
  $('storage-warning').hidden = false;
  $('save-state').textContent = '설정 저장 상태를 확인해 주세요';
}
function writeSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $('storage-warning').hidden = true;
    $('save-state').textContent = '이 브라우저에 자동 저장';
  } catch {
    storageWarning('설정을 저장할 수 없어 현재 탭에만 적용했습니다. 탭을 닫기 전에 ‘설정 내보내기’로 백업해 주세요.');
  }
}
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved !== null) state = validateSettings(JSON.parse(saved));
  else writeSettings();
} catch {
  storageWarning('저장된 설정을 읽을 수 없어 기본값으로 표시합니다. 기존 저장 내용은 유지됩니다. 파일을 불러오거나 시간을 설정하면 새 설정으로 저장됩니다.');
}
function commit(next, message, undo = null) {
  state = validateSettings(next);
  undoState = undo;
  writeSettings();
  previousTick = Date.now();
  render(previousTick);
  showToast(message);
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
function render(now = Date.now()) {
  const wall = formatWall(now);
  $('current-clock').textContent = wall.time;
  $('current-clock').dateTime = kstISO(now) + '+09:00';
  $('current-date').textContent = wall.year + ' · UTC+9';
  const ordered = schedule(state.bosses, now), nearest = ordered[0];
  $('next-level').textContent = ordered.filter(boss => boss.due === nearest.due).map(boss => 'Lv.' + boss.level).join(' · ');
  const nextWall = formatWall(nearest.due);
  $('next-at').textContent = nextWall.date + '  ' + nextWall.time + ' 리젠 예정';
  $('next-countdown').textContent = remainingText(nearest.remaining);
  $('next-status').textContent = nearest.soon ? '5분 이내 · 리젠 임박' : '다음 리젠 대기 중';
  document.querySelector('.next-spawn').classList.toggle('soon', nearest.soon);
  document.title = remainingText(nearest.remaining) + ' · Lv.' + nearest.level + ' | 이클립스';
  for (const boss of ordered) {
    const nodes = rowNodes.get(boss.level);
    nodes.interval.textContent = intervalText(boss.interval_seconds);
    nodes.remaining.textContent = remainingText(boss.remaining);
    nodes.row.classList.toggle('soon', boss.soon);
    nodes.row.classList.toggle('nearest', boss.due === nearest.due);
    nodes.status.textContent = boss.soon ? '임박' : boss.due === nearest.due ? 'NEXT' : '';
    setWall(nodes.next, boss.due);
    setWall(nodes.anchor, parseKST(boss.anchor_kst));
    nodes.progress.style.width = (boss.progress * 100) + '%';
  }
  const display = sortMode === 'next' ? ordered : [...ordered].sort((a, b) => a.level - b.level);
  const parent = $('boss-rows');
  display.forEach((boss, index) => {
    const node = rowNodes.get(boss.level).row;
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  });
  $('undo').disabled = !undoState;
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
  const now = Date.now(), crossed = crossedOccurrences(state.bosses, previousTick, now);
  if (crossed.length) {
    showToast(crossed.map(boss => 'Lv.' + boss.level).join(', ') + '의 설정된 리젠 시각입니다.');
    if (state.sound) playTone();
  }
  render(now);
  previousTick = now;
}
function openEditor(levels) {
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
function reset(levels) {
  const previous = { bosses: structuredClone(state.bosses) };
  commit({ ...state, bosses: resetBosses(state.bosses, levels) }, levels.length === 6 ? '6개 보스의 기준 시각을 현재 시각으로 초기화했습니다.' : 'Lv.' + levels[0] + '의 기준 시각을 현재 시각으로 초기화했습니다.', previous);
}
$('boss-rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const level = Number(button.closest('[data-level]').dataset.level);
  if (button.dataset.action === 'edit') openEditor([level]); else reset([level]);
});
$('edit-all').addEventListener('click', () => openEditor(LEVELS));
$('reset-all').addEventListener('click', () => $('confirm-dialog').showModal());
$('confirm-reset').addEventListener('click', () => { reset(LEVELS); $('confirm-dialog').close(); });
$('undo').addEventListener('click', () => { if (undoState) commit({ ...state, ...undoState }, '이전 설정으로 되돌렸습니다.'); });
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
  const row = button.closest('fieldset'), now = kstISO();
  row.querySelector('[name="date"]').value = now.slice(0, 10);
  row.querySelector('[name="time"]').value = now.slice(11);
});
$('edit-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const bosses = structuredClone(state.bosses);
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
    commit({ ...state, bosses }, '시간 설정을 저장했습니다. 새 기준으로 리젠을 계산합니다.');
    $('edit-dialog').close();
  } catch (error) { $('edit-error').textContent = error.message; }
});
$('sound-toggle').addEventListener('click', async () => {
  if (audioBusy) return;
  audioBusy = true;
  try {
    const enabled = !state.sound;
    if (enabled) { await enableAudio(); playTone(); }
    commit({ ...state, sound: enabled }, enabled ? '리젠 알림음을 켰습니다.' : '리젠 알림음을 껐습니다.', undoState);
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
  link.download = 'eclipse-boss-timer-' + kstISO().slice(0, 10) + '.json';
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
    $('import-dialog').showModal();
  } catch (error) {
    pendingImport = null;
    showToast(error instanceof SyntaxError ? 'JSON 형식의 설정 파일을 선택해 주세요.' : error.message);
  } finally { event.target.value = ''; }
});
$('confirm-import').addEventListener('click', () => {
  if (!pendingImport) return;
  commit(pendingImport, '6개 보스의 설정을 불러왔습니다.', { bosses: structuredClone(state.bosses), sound: state.sound });
  $('import-dialog').close();
});
$('import-dialog').addEventListener('close', () => { pendingImport = null; });
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY) return;
  try {
    if (event.newValue === null) {
      storageWarning('다른 탭에서 저장된 설정이 삭제되었습니다. 현재 타이머는 유지됩니다. 설정을 내보내 백업할 수 있습니다.');
      return;
    }
    state = validateSettings(JSON.parse(event.newValue));
    undoState = null;
    if ($('edit-dialog').open) $('edit-dialog').close();
    previousTick = Date.now();
    render(previousTick);
    $('storage-warning').hidden = true;
    $('save-state').textContent = '이 브라우저에 자동 저장';
    showToast('다른 탭에서 변경한 설정을 반영했습니다.');
  } catch { storageWarning('다른 탭의 설정을 읽지 못했습니다. 현재 타이머는 유지됩니다.'); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
makeRows();
render();
setInterval(tick, 200);
