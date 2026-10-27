export const LEVELS = Object.freeze([40, 50, 60, 70, 75, 80]);
export const STORAGE_KEY = 'eclipse-boss-timer.v1';
export const MAX_INTERVAL = 999 * 3600 + 3599;
const KST_OFFSET = 9 * 3600 * 1000;

export function kstISO(timestamp = Date.now()) {
  return new Date(timestamp + KST_OFFSET).toISOString().slice(0, 19);
}

export function parseKST(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new Error('기준 날짜와 시간을 정확히 입력해 주세요.');
  }
  const year = Number(value.slice(0, 4));
  const timestamp = Date.parse(value + '+09:00');
  if (year < 2000 || year > 2090 || !Number.isFinite(timestamp) || kstISO(timestamp) !== value) {
    throw new Error('기준 날짜는 2000~2090년의 유효한 날짜여야 합니다.');
  }
  return timestamp;
}

// Matches the saved desktop configuration at migration, including Lv.75 at 18:15.
export function defaultSettings() {
  const values = [[40, '18:02', 8], [50, '18:04', 8], [60, '14:03', 10], [70, '18:05', 12], [75, '18:15', 12], [80, '00:18', 15]];
  return {
    version: 1, timezone: 'Asia/Seoul', sound: false, topmost: false,
    bosses: values.map(([level, clock, hours]) => ({ level, interval_seconds: hours * 3600, anchor_kst: '2026-10-22T' + clock + ':00' }))
  };
}

export function validateSettings(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.bosses) || value.bosses.length !== LEVELS.length) {
    throw new Error('지원하는 보스타이머 설정 파일이 아닙니다.');
  }
  if (value.timezone !== undefined && value.timezone !== 'Asia/Seoul') {
    throw new Error('한국시간(Asia/Seoul)으로 저장된 설정만 불러올 수 있습니다.');
  }
  const bosses = value.bosses.map((boss, index) => {
    if (!boss || boss.level !== LEVELS[index]) throw new Error('Lv.40, 50, 60, 70, 75, 80 설정이 순서대로 필요합니다.');
    if (!Number.isInteger(boss.interval_seconds) || boss.interval_seconds < 1 || boss.interval_seconds > MAX_INTERVAL) {
      throw new Error('Lv.' + boss.level + ': 리젠 간격은 1초 이상, 999시간 59분 59초 이하여야 합니다.');
    }
    parseKST(boss.anchor_kst);
    return { level: boss.level, interval_seconds: boss.interval_seconds, anchor_kst: boss.anchor_kst };
  });
  return { version: 1, timezone: 'Asia/Seoul', sound: value.sound === true, topmost: false, bosses };
}

export function nextOccurrence(boss, now = Date.now()) {
  const anchor = parseKST(boss.anchor_kst);
  const interval = boss.interval_seconds * 1000;
  if (!Number.isInteger(boss.interval_seconds) || interval < 1000 || boss.interval_seconds > MAX_INTERVAL) throw new Error('리젠 간격이 올바르지 않습니다.');
  if (anchor > now) return anchor;
  return anchor + (Math.floor((now - anchor) / interval) + 1) * interval;
}

export function remainingText(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(number => String(number).padStart(2, '0')).join(':');
}

export function intervalText(seconds) {
  return [[Math.floor(seconds / 3600), '시간'], [Math.floor(seconds / 60) % 60, '분'], [seconds % 60, '초']]
    .filter(([value]) => value).map(([value, unit]) => value + unit).join(' ');
}

export function schedule(bosses, now = Date.now()) {
  return bosses.map(boss => {
    const due = nextOccurrence(boss, now);
    const remaining = due - now;
    return { ...boss, due, remaining, soon: remaining <= 300000, progress: Math.max(0, Math.min(1, 1 - remaining / (boss.interval_seconds * 1000))) };
  }).sort((a, b) => a.due - b.due || a.level - b.level);
}

export function resetBosses(bosses, levels, now = Date.now()) {
  const anchor = kstISO(now);
  return bosses.map(boss => levels.includes(boss.level) ? { ...boss, anchor_kst: anchor } : { ...boss });
}

export function crossedOccurrences(bosses, previous, now) {
  if (now <= previous || now - previous > 120000) return [];
  return bosses.filter(boss => nextOccurrence(boss, previous) <= now);
}
