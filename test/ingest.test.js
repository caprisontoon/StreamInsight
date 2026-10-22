import assert from 'node:assert/strict';
import { test } from 'node:test';
import { all, get, migrate, openDb } from '../src/db.js';
import { ingest, parseTimeline, recordFollowers } from '../src/ingest.js';
import * as Q from '../src/queries.js';
import { kstDate } from '../src/util.js';

const I = 300;
const T0 = 1792100000 - (1792100000 % I);
const live = (ch, key, viewers, category = '토크') => ({ channelId: ch, channelName: `이름${ch}`, streamKey: key, title: 't', category, viewers });

async function memDb() {
  const db = openDb('file::memory:');
  await migrate(db);
  return db;
}

test('방송 중에는 streams 행에 누적되고, 끝나면 daily 로 옮겨진다', async () => {
  const db = await memDb();
  await ingest(db, 'chzzk', [live('a', 's1', 100), live('b', 's2', 50)], T0, I);
  await ingest(db, 'chzzk', [live('a', 's1', 300), live('b', 's2', 50)], T0 + I, I);
  await ingest(db, 'chzzk', [live('a', 's1', 200, '게임')], T0 + 2 * I, I);

  const s1 = await get(db, "SELECT * FROM streams WHERE stream_key = 's1'");
  assert.equal(s1.peak_viewers, 300);
  assert.equal(s1.samples, 3);
  assert.equal(s1.air_sec, 3 * I);
  assert.equal(s1.viewer_sec, (100 + 300 + 200) * I);
  assert.equal(s1.category, '게임');
  assert.deepEqual(parseTimeline(s1.timeline).map((p) => p.viewers), [100, 300, 200]);
  assert.deepEqual(JSON.parse(s1.segments).map((x) => x[1]), ['토크', '게임']);

  // 방송 중인 동안 daily 는 비어 있고, 집계는 day_stats 에 있다
  assert.equal((await all(db, 'SELECT * FROM daily')).length, 0);
  const date = kstDate(T0);
  const r = await Q.rankings(db, { from: date, to: date });
  assert.equal(r.items.find((x) => x.channelId === 'a').watchHours, (600 * I) / 3600);

  // b 는 grace(2.5주기) 이후 종료 → daily 로 옮겨지고 day_stats 는 비워짐
  await ingest(db, 'chzzk', [live('a', 's1', 200)], T0 + 3 * I, I);
  await ingest(db, 'chzzk', [live('a', 's1', 200)], T0 + 4 * I, I);
  const s2 = await get(db, "SELECT * FROM streams WHERE stream_key = 's2'");
  assert.equal(s2.ended_at, T0 + I);
  assert.equal(s2.day_stats, '{}');
  const bDaily = await all(db, "SELECT * FROM daily WHERE channel_id = 'b'");
  assert.equal(bDaily.length, 1);
  assert.equal(bDaily[0].viewer_sec, 100 * I);

  // 종료 전후로 랭킹 합계가 같아야 한다 (이중 집계 없음)
  const r2 = await Q.rankings(db, { from: date, to: date });
  assert.equal(r2.items.find((x) => x.channelId === 'b').watchHours, (100 * I) / 3600);
});

test('수집 공백이 길어도 한 번의 시간은 2주기로 제한된다', async () => {
  const db = await memDb();
  await ingest(db, 'soop', [live('a', 's1', 100)], T0, I);
  await ingest(db, 'soop', [live('a', 's1', 100)], T0 + 2 * I, I);
  await ingest(db, 'soop', [live('a', 's1', 100)], T0 + 12 * I, I);
  const s = await get(db, 'SELECT air_sec FROM streams');
  // 첫 1주기 + 2주기 + (10주기 공백 → 최대 2주기)
  assert.equal(s.air_sec, I + 2 * I + 2 * I);
});

test('같은 시각 재수집과 중복 항목은 한 번만 반영된다', async () => {
  const db = await memDb();
  await ingest(db, 'chzzk', [live('a', 's1', 100), live('a', 's1', 120)], T0, I);
  await ingest(db, 'chzzk', [live('a', 's1', 100)], T0, I);
  const s = await get(db, 'SELECT samples, peak_viewers FROM streams');
  assert.equal(s.samples, 1);
  assert.equal(s.peak_viewers, 120);
});

test('종료 후 다시 나타난 방송은 이어서 기록하되 이중 집계하지 않는다', async () => {
  const db = await memDb();
  await ingest(db, 'chzzk', [live('a', 's1', 100)], T0, I);
  await ingest(db, 'chzzk', [], T0 + 3 * I, I); // 종료
  await ingest(db, 'chzzk', [live('a', 's1', 100)], T0 + 4 * I, I); // 재등장
  const s = await get(db, 'SELECT ended_at, samples FROM streams');
  assert.equal(s.ended_at, null);
  assert.equal(s.samples, 2);
  const date = kstDate(T0);
  const r = await Q.rankings(db, { from: date, to: date });
  assert.equal(r.items[0].airHours, (I + 2 * I) / 3600);
});

test('랭킹·채널 상세·방송 상세·비교·검색 쿼리', async () => {
  const db = await memDb();
  for (let k = 0; k < 6; k++) {
    await ingest(db, 'chzzk', [live('big', 'b1', 1000), live('small', 's1', 10)], T0 + k * I, I);
    await ingest(db, 'soop', [live('mid', 'm1', 500, '게임')], T0 + k * I, I);
  }
  await recordFollowers(db, 'chzzk', 'big', 12345, T0);
  const date = kstDate(T0);

  const r = await Q.rankings(db, { from: date, to: date, sort: 'watch' });
  assert.deepEqual(r.items.map((i) => i.channelId), ['big', 'mid', 'small']);
  assert.equal(r.total, 3);
  assert.equal(r.items[0].avgViewers, 1000);
  assert.equal(r.items[0].followers, 12345);
  assert.equal(r.items[0].mainCategory, '토크');
  assert.ok(r.items[0].live);

  assert.deepEqual((await Q.rankings(db, { from: date, to: date, platform: 'soop' })).items.map((i) => i.channelId), ['mid']);
  assert.deepEqual((await Q.rankings(db, { from: date, to: date, category: '게임' })).items.map((i) => i.channelId), ['mid']);

  const d = await Q.channelDetail(db, 'chzzk', 'big', { from: date, to: date }, { intervalSec: I });
  assert.equal(d.summary.peakViewers, 1000);
  assert.equal(d.summary.rank, 1);
  assert.equal(d.streams.length, 1);
  const heatAir = d.heatmap.reduce((a, h) => a + h.airHours, 0);
  assert.equal(heatAir, (6 * I) / 3600);

  const sd = await Q.streamDetail(db, d.streams[0].id);
  assert.equal(sd.timeline.length, 6);
  assert.equal(sd.segments[0].category, '토크');

  const cats = await Q.categories(db, { from: date, to: date });
  assert.equal(cats.items[0].category, '토크');

  const cmp = await Q.compare(db, ['chzzk:big', 'soop:mid', 'twitch:none'], { from: date, to: date }, { intervalSec: I });
  assert.equal(cmp.items.length, 2);

  const batch = await Q.channelsBatch(db, ['chzzk:big', 'soop:mid'], { from: date, to: date });
  assert.equal(batch.items.length, 2);

  const search = await Q.searchChannels(db, { q: '이름b' });
  assert.equal(search.items[0].channelId, 'big');

  const st = await Q.status(db, { intervalSec: I, demo: false, minViewers: 5, enableCollector: true });
  assert.equal(st.channels, 3);
});
