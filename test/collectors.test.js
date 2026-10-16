import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createChzzkCollector, normalizeChzzkLive } from '../src/collectors/chzzk.js';
import { createSoopCollector, normalizeSoopLive } from '../src/collectors/soop.js';
import { normalizeTwitchStream } from '../src/collectors/twitch.js';
import { parseKst } from '../src/util.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const cfg = {
  chzzkApiBase: 'https://api.chzzk.naver.com',
  soopListApi: 'https://live.sooplive.co.kr/api/main_broad_list_api.php',
  soopStationApi: 'https://chapi.sooplive.co.kr/api',
  maxPages: 10,
  minViewers: 5,
};

const chzzkLive = (id, viewers) => ({
  liveId: id,
  liveTitle: `방송 ${id}`,
  liveImageUrl: 'https://livecloud-thumb.akamaized.net/x/image_{type}.jpg',
  concurrentUserCount: viewers,
  openDate: '2026-10-16 18:30:00',
  adult: false,
  liveCategoryValue: '리그 오브 레전드',
  channel: { channelId: `ch${id}`, channelName: `채널${id}`, channelImageUrl: 'https://example.com/p.png' },
});

test('치지직 라이브 항목 정규화', () => {
  const n = normalizeChzzkLive(chzzkLive(1, 1234));
  assert.equal(n.channelId, 'ch1');
  assert.equal(n.streamKey, 1);
  assert.equal(n.viewers, 1234);
  assert.equal(n.category, '리그 오브 레전드');
  assert.equal(n.thumbnail, 'https://livecloud-thumb.akamaized.net/x/image_480.jpg');
  assert.equal(n.startedAt, parseKst('2026-10-16 18:30:00'));
});

test('치지직 수집기는 커서를 따라가다 최소 시청자 미만에서 멈춘다', async () => {
  const pages = [
    { data: [chzzkLive(1, 500), chzzkLive(2, 100)], next: { concurrentUserCount: 100, liveId: 2 } },
    { data: [chzzkLive(3, 20), chzzkLive(4, 3)], next: { concurrentUserCount: 3, liveId: 4 } },
    { data: [chzzkLive(5, 1)], next: null },
  ];
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const p = pages[urls.length - 1];
    return new Response(JSON.stringify({ code: 200, content: { data: p.data, page: { next: p.next } } }));
  };
  const lives = await createChzzkCollector(cfg).fetchLives();
  assert.equal(urls.length, 2);
  assert.match(urls[1], /concurrentUserCount=100/);
  assert.match(urls[1], /liveId=2/);
  assert.deepEqual(lives.map((l) => l.streamKey), [1, 2, 3]);
});

test('SOOP 방송 항목 정규화', () => {
  const n = normalizeSoopLive({
    broad_no: '280000001',
    broad_title: '테스트 방송',
    user_id: 'abcd1234',
    user_nick: '닉네임',
    total_view_cnt: '4321',
    broad_start: '2026-10-16 20:00:00',
    broad_thumb: '//liveimg.sooplive.co.kr/m/280000001',
    broad_grade: '0',
    category_tags: ['토크/캠방'],
  });
  assert.equal(n.channelId, 'abcd1234');
  assert.equal(n.viewers, 4321);
  assert.equal(n.category, '토크/캠방');
  assert.equal(n.thumbnail, 'https://liveimg.sooplive.co.kr/m/280000001');
  assert.equal(n.channelImage, 'https://profile.img.sooplive.co.kr/LOGO/ab/abcd1234/abcd1234.jpg');
});

test('SOOP 수집기는 빈 페이지에서 멈춘다', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const broad = calls === 1 ? [{ broad_no: '1', user_id: 'u1', user_nick: 'a', total_view_cnt: '50' }] : [];
    return new Response(JSON.stringify({ broad }));
  };
  const lives = await createSoopCollector(cfg).fetchLives();
  assert.equal(calls, 2);
  assert.equal(lives.length, 1);
});

test('트위치 스트림 정규화', () => {
  const n = normalizeTwitchStream({
    id: '42', user_id: '7', user_login: 'tester', user_name: '테스터', game_name: 'VALORANT', title: 't',
    viewer_count: 99, started_at: '2026-10-16T10:00:00Z', thumbnail_url: 'https://x/{width}x{height}.jpg',
  });
  assert.equal(n.channelId, '7');
  assert.equal(n.login, 'tester');
  assert.equal(n.thumbnail, 'https://x/480x270.jpg');
  assert.equal(n.startedAt, Date.parse('2026-10-16T10:00:00Z') / 1000);
});
