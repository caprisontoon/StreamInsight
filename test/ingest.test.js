import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { ingest, recordFollowers } from '../src/ingest.js';
import * as Q from '../src/queries.js';
import { kstDate } from '../src/util.js';

const I = 300;
const live = (ch, key, viewers, category = '토크') => ({ channelId: ch, channelName: `이름${ch}`, streamKey: key, title: 't', category, viewers });

test('스냅샷이 방송·일별 집계로 누적되고, 사라진 방송은 종료 처리된다', () => {
  const db = openDb(':memory:');
  const t0 = 1792100000 - (1792100000 % I);
  ingest(db, 'chzzk', [live('a', 's1', 100), live('b', 's2', 50)], t0, I);
  ingest(db, 'chzzk', [live('a', 's1', 300), live('b', 's2', 50)], t0 + I, I);
  ingest(db, 'chzzk', [live('a', 's1', 200, '게임')], t0 + 2 * I, I);

  const s1 = db.prepare("SELECT * FROM streams WHERE stream_key = 's1'").get();
  assert.equal(s1.peak_viewers, 300);
  assert.equal(s1.samples, 3);
  assert.equal(s1.air_sec, 3 * I);
  assert.equal(s1.viewer_sec, (100 + 300 + 200) * I);
  assert.equal(s1.category, '게임');

  // b 는 grace(2.5주기) 이후 종료
  ingest(db, 'chzzk', [live('a', 's1', 200)], t0 + 3 * I, I);
  ingest(db, 'chzzk', [live('a', 's1', 200)], t0 + 4 * I, I);
  const s2 = db.prepare("SELECT * FROM streams WHERE stream_key = 's2'").get();
  assert.equal(s2.ended_at, t0 + I);

  const daily = db.prepare("SELECT category, viewer_sec, air_sec, peak FROM daily WHERE channel_id = 'a' ORDER BY category").all();
  assert.ok(daily.length >= 1);
  const totalAir = daily.reduce((a, d) => a + d.air_sec, 0);
  assert.equal(totalAir, 5 * I);
});

test('수집 공백이 길어도 한 스냅샷의 시간은 2주기로 제한된다', () => {
  const db = openDb(':memory:');
  const t0 = 1792100000 - (1792100000 % I);
  ingest(db, 'soop', [live('a', 's1', 100)], t0, I);
  ingest(db, 'soop', [live('a', 's1', 100)], t0 + 10 * I, I);
  const s = db.prepare('SELECT air_sec FROM streams').get();
  assert.equal(s.air_sec, I + 2 * I);
});

test('같은 시각 재수집과 중복 항목은 한 번만 반영된다', () => {
  const db = openDb(':memory:');
  const t0 = 1792100000 - (1792100000 % I);
  ingest(db, 'chzzk', [live('a', 's1', 100), live('a', 's1', 120)], t0, I);
  ingest(db, 'chzzk', [live('a', 's1', 100)], t0, I);
  const s = db.prepare('SELECT samples, peak_viewers FROM streams').get();
  assert.equal(s.samples, 1);
  assert.equal(s.peak_viewers, 120);
});

test('랭킹·채널 상세·비교 쿼리', () => {
  const db = openDb(':memory:');
  const t0 = 1792100000 - (1792100000 % I);
  for (let k = 0; k < 6; k++) {
    ingest(db, 'chzzk', [live('big', 'b1', 1000), live('small', 's1', 10)], t0 + k * I, I);
    ingest(db, 'soop', [live('mid', 'm1', 500, '게임')], t0 + k * I, I);
  }
  recordFollowers(db, 'chzzk', 'big', 12345, t0);
  const date = kstDate(t0);

  const r = Q.rankings(db, { from: date, to: date, sort: 'watch' });
  assert.deepEqual(r.items.map((i) => i.channelId), ['big', 'mid', 'small']);
  assert.equal(r.items[0].avgViewers, 1000);
  assert.equal(r.items[0].followers, 12345);

  const onlySoop = Q.rankings(db, { from: date, to: date, platform: 'soop' });
  assert.deepEqual(onlySoop.items.map((i) => i.channelId), ['mid']);

  const byCat = Q.rankings(db, { from: date, to: date, category: '게임' });
  assert.deepEqual(byCat.items.map((i) => i.channelId), ['mid']);

  const d = Q.channelDetail(db, 'chzzk', 'big', { from: date, to: date });
  assert.equal(d.summary.peakViewers, 1000);
  assert.equal(d.summary.rank, 1);
  assert.equal(d.streams.length, 1);

  const cats = Q.categories(db, { from: date, to: date });
  assert.equal(cats.items[0].category, '토크');

  const cmp = Q.compare(db, ['chzzk:big', 'soop:mid', 'twitch:none'], { from: date, to: date });
  assert.equal(cmp.items.length, 2);

  const search = Q.searchChannels(db, { q: '이름b' });
  assert.equal(search.items[0].channelId, 'big');
});
