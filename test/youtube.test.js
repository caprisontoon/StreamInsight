import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createYoutubeCollector, isKorean, normalizeYoutubeVideo } from '../src/collectors/youtube.js';
import { openDb } from '../src/db.js';
import { ingest } from '../src/ingest.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const cfg = {
  youtubeApiKey: 'test-key',
  youtubeChannelIds: [],
  youtubeSearchIntervalMin: 60,
  youtubeSearchPages: 2,
  youtubeRssIntervalMin: 10,
  youtubeRegion: 'KR',
  youtubeLanguage: 'ko',
  youtubeKoreanOnly: true,
  youtubeExcludeCategories: ['25'],
  youtubeDailyQuota: 10000,
  youtubeQuotaReserve: 2000,
  minViewers: 5,
};

const video = (id, { title = '한국어 방송', channelTitle = `채널${id}`, state = 'live', viewers = '1500', categoryId = '20', ended = false } = {}) => ({
  id,
  snippet: {
    channelId: `UC${id}`, channelTitle, title, categoryId, liveBroadcastContent: state,
    thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault_live.jpg` } },
  },
  liveStreamingDetails: {
    actualStartTime: '2026-10-16T10:00:00Z',
    ...(viewers !== null ? { concurrentViewers: viewers } : {}),
    ...(ended ? { actualEndTime: '2026-10-16T12:00:00Z' } : {}),
  },
});

const VIDEOS = {
  v1: video('v1'),
  v2: video('v2', { title: 'English stream', channelTitle: 'Some Channel' }),
  v3: video('v3', { title: '뉴스 특보', categoryId: '25' }),
  v4: video('v4', { state: 'none', ended: true }),
  v5: video('v5', { viewers: null }),
  v6: video('v6', { state: 'upcoming', viewers: null }),
};

function mockApi(log, searchIds = Object.keys(VIDEOS)) {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    log.push(url);
    if (url.pathname.endsWith('/search')) {
      return Response.json({ items: searchIds.map((id) => ({ id: { videoId: id } })) });
    }
    if (url.pathname.endsWith('/videos')) {
      const ids = url.searchParams.get('id').split(',');
      return Response.json({ items: ids.map((id) => VIDEOS[id]).filter(Boolean) });
    }
    if (url.pathname.endsWith('/channels')) {
      const ids = url.searchParams.get('id').split(',');
      return Response.json({ items: ids.map((id) => ({ id, snippet: { customUrl: `@${id}`, thumbnails: { default: { url: `https://yt3.ggpht.com/${id}` } } }, statistics: { subscriberCount: '4321' } })) });
    }
    if (url.hostname === 'www.youtube.com') {
      return new Response('<feed><entry><yt:videoId>v1</yt:videoId></entry><entry><yt:videoId>v9</yt:videoId></entry></feed>');
    }
    return new Response('not found', { status: 404 });
  };
}

test('유튜브 영상 정규화와 한국어 판별', () => {
  const n = normalizeYoutubeVideo(VIDEOS.v1, { handle: '@ch', image: 'https://img' });
  assert.equal(n.streamKey, 'v1');
  assert.equal(n.channelId, 'UCv1');
  assert.equal(n.viewers, 1500);
  assert.equal(n.category, '게임');
  assert.equal(n.login, '@ch');
  assert.equal(n.startedAt, Date.parse('2026-10-16T10:00:00Z') / 1000);
  assert.ok(isKorean(VIDEOS.v1));
  assert.ok(!isKorean(VIDEOS.v2));
  assert.ok(isKorean({ snippet: { title: 'stream', defaultAudioLanguage: 'ko' } }));
});

test('검색으로 찾은 방송 중 한국어·비뉴스·시청자 공개 라이브만 수집하고 쿼터를 계산한다', async () => {
  const log = [];
  mockApi(log);
  const yt = createYoutubeCollector(cfg);
  const lives = await yt.fetchLives();
  assert.deepEqual(lives.map((l) => l.streamKey), ['v1']);
  assert.equal(lives[0].login, '@UCv1');
  // search 100 + videos 1 + channels 1
  assert.equal(yt.quota().used, 102);
  assert.equal(log.filter((u) => u.pathname.endsWith('/search')).length, 1);
  assert.equal(log[0].searchParams.get('eventType'), 'live');
  assert.equal(log[0].searchParams.get('key'), 'test-key');

  // 두 번째 수집: 검색 주기 전이므로 검색하지 않고, 제외·종료된 영상은 다시 조회하지 않는다
  log.length = 0;
  const again = await yt.fetchLives();
  assert.deepEqual(again.map((l) => l.streamKey), ['v1']);
  assert.equal(log.filter((u) => u.pathname.endsWith('/search')).length, 0);
  const polled = log.find((u) => u.pathname.endsWith('/videos')).searchParams.get('id').split(',').sort();
  assert.deepEqual(polled, ['v1', 'v5', 'v6']);
  assert.equal(yt.quota().used, 103);
});

test('쿼터가 예약분 이하로 남으면 검색을 건너뛴다', async () => {
  const log = [];
  mockApi(log);
  const yt = createYoutubeCollector({ ...cfg, youtubeDailyQuota: 2050 });
  const lives = await yt.fetchLives();
  assert.equal(lives.length, 0);
  assert.equal(log.filter((u) => u.pathname.endsWith('/search')).length, 0);
});

test('DB에 방송 중으로 남은 영상과 지정 채널 RSS 영상을 추적한다', async () => {
  const db = openDb(':memory:');
  ingest(db, 'youtube', [{ channelId: 'UCv5', channelName: 'x', streamKey: 'v5', viewers: 10 }], 1792100000, 300);
  const log = [];
  mockApi(log, []);
  const yt = createYoutubeCollector({ ...cfg, youtubeChannelIds: ['UCabc'] }, { db });
  await yt.fetchLives();
  assert.ok(log.some((u) => u.hostname === 'www.youtube.com' && u.searchParams.get('channel_id') === 'UCabc'));
  const polled = log.find((u) => u.pathname.endsWith('/videos')).searchParams.get('id').split(',').sort();
  assert.deepEqual(polled, ['v1', 'v5', 'v9']);
});

test('구독자 수 조회', async () => {
  mockApi([]);
  const yt = createYoutubeCollector(cfg);
  assert.equal(await yt.fetchFollowers('UCv1'), 4321);
});
