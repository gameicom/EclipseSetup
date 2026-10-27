import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, validateSettings, kstISO, parseKST, nextOccurrence, remainingText, schedule, resetBosses, crossedOccurrences, MAX_INTERVAL } from '../dist/core.js';
const ms = value => Date.parse(value + '+09:00');

test('desktop defaults, including saved Lv.75 time, round trip without mutation', () => {
  const settings = defaultSettings();
  assert.equal(settings.bosses[4].anchor_kst, '2026-10-22T18:15:00');
  assert.deepEqual(validateSettings(JSON.parse(JSON.stringify(settings))), settings);
  const parsed = validateSettings(settings);
  parsed.bosses[0].interval_seconds = 1;
  assert.equal(settings.bosses[0].interval_seconds, 28800);
});
test('strict next occurrence matches desktop across future, exact and many expired cycles', () => {
  const boss = defaultSettings().bosses[0];
  assert.equal(nextOccurrence(boss, ms('2026-10-22T18:01:59')), ms('2026-10-22T18:02:00'));
  assert.equal(nextOccurrence(boss, ms('2026-10-22T18:02:00')), ms('2026-10-23T02:02:00'));
  assert.equal(nextOccurrence(boss, ms('2026-10-22T18:03:00')), ms('2026-10-23T02:02:00'));
  assert.equal(nextOccurrence(boss, ms('2026-10-27T18:02:00')), ms('2026-10-28T02:02:00'));
});
test('KST is independent of host timezone and preserves leap dates', () => {
  assert.equal(kstISO(Date.parse('2026-10-22T15:18:00Z')), '2026-10-23T00:18:00');
  assert.equal(parseKST('2028-02-29T23:59:59'), ms('2028-02-29T23:59:59'));
  for (const date of ['2026-02-29T12:00:00','2026-04-31T12:00:00','2026-10-22T24:00:00','1999-12-31T23:59:59','2091-01-01T00:00:00','2026-10-22T18:02:00Z']) assert.throws(() => parseKST(date));
});
test('reset preserves intervals and unrelated bosses, while allowing exact undo', () => {
  const original = defaultSettings().bosses, now = ms('2026-10-27T09:15:30');
  const reset = resetBosses(original, [50], now);
  assert.equal(reset[1].anchor_kst, '2026-10-27T09:15:30');
  assert.equal(nextOccurrence(reset[1], now), ms('2026-10-27T17:15:30'));
  assert.deepEqual(reset[0], original[0]);
  assert.equal(original[1].anchor_kst, '2026-10-22T18:04:00');
  assert.ok(resetBosses(original, [40,50,60,70,75,80], now).every(b => b.anchor_kst === kstISO(now)));
});
test('countdown rounds up, does not show negative time, and supports long intervals', () => {
  assert.equal(remainingText(1), '00:00:01');
  assert.equal(remainingText(-1), '00:00:00');
  assert.equal(remainingText(3661000), '01:01:01');
  assert.equal(remainingText(MAX_INTERVAL * 1000), '999:59:59');
});
test('schedule supports tied and future anchors, with bounded progress', () => {
  const bosses = defaultSettings().bosses;
  bosses[1].anchor_kst = bosses[0].anchor_kst;
  const rows = schedule(bosses, ms('2026-10-22T18:00:00'));
  assert.deepEqual(rows.slice(0, 2).map(b => b.level), [40,50]);
  assert.equal(rows[0].soon, true);
  assert.equal(rows[0].remaining, 120000);
  assert.ok(rows.every(b => b.progress >= 0 && b.progress <= 1));
});
test('alarms cross a boundary once and skip long sleep or backwards clocks', () => {
  const bosses = defaultSettings().bosses;
  const due = ms('2026-10-23T02:02:00');
  assert.deepEqual(crossedOccurrences(bosses, due - 200, due + 100).map(b => b.level), [40]);
  assert.deepEqual(crossedOccurrences(bosses, due + 100, due + 300), []);
  assert.deepEqual(crossedOccurrences(bosses, due - 121000, due), []);
  assert.deepEqual(crossedOccurrences(bosses, due, due - 1000), []);
});
test('invalid settings never silently become valid timers', () => {
  const bad = mutator => { const settings = defaultSettings(); mutator(settings); assert.throws(() => validateSettings(settings)); };
  bad(s => { s.version = 2; });
  bad(s => { s.timezone = 'UTC'; });
  bad(s => { s.bosses.pop(); });
  bad(s => { s.bosses[0].level = 50; });
  for (const interval of [0,-1,1.5,'28800',Infinity,MAX_INTERVAL+1]) bad(s => { s.bosses[0].interval_seconds = interval; });
  bad(s => { s.bosses[0].anchor_kst = '2026-02-30T00:00:00'; });
  assert.equal(validateSettings({...defaultSettings(), topmost:true}).topmost, false);
});
