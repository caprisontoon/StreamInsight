import { all } from '../db.js';
import { fetchJson, fetchText } from '../util.js';

/**
 * 유튜브 YouTube Data API v3 (API 키 필요, 하루 쿼터 기본 10,000 단위)
 *
 * 쿼터를 아끼기 위해 "발견"과 "추적"을 나눈다.
 *  - 발견: search.list (eventType=live, regionCode=KR, 시청자순) → 1회 100단위, 기본 1시간마다 2페이지
 *  - 지정 채널: 채널 RSS 피드(쿼터 없음)에서 최근 영상 ID를 가져와 후보에 추가
 *  - 추적: videos.list 로 후보·방송 중 영상의 동시 시청자 조회 → 50개당 1단위, 매 수집 주기
 *  - 채널 정보: channels.list (프로필 이미지, 핸들, 구독자 수) → 50개당 1단위
 */
const API = 'https://www.googleapis.com/youtube/v3';

export const YT_CATEGORIES = {
  1: '영화/애니메이션',
  2: '자동차',
  10: '음악',
  15: '동물',
  17: '스포츠',
  19: '여행/이벤트',
  20: '게임',
  22: '인물/블로그',
  23: '코미디',
  24: '엔터테인먼트',
  25: '뉴스/정치',
  26: '노하우/스타일',
  27: '교육',
  28: '과학기술',
  29: '비영리/사회운동',
};

const HANGUL = /[가-힣]/;
const DAY = 86400000;

/** 한국어 방송 판별: 오디오/기본 언어가 ko 이거나 제목·채널명에 한글이 있으면 한국어로 본다 */
export function isKorean(v) {
  const sn = v.snippet || {};
  const lang = sn.defaultAudioLanguage || sn.defaultLanguage || '';
  return lang.toLowerCase().startsWith('ko') || HANGUL.test(sn.title || '') || HANGUL.test(sn.channelTitle || '');
}

export function normalizeYoutubeVideo(v, channel) {
  const sn = v.snippet || {};
  const ls = v.liveStreamingDetails || {};
  return {
    channelId: sn.channelId,
    channelName: sn.channelTitle,
    login: channel?.handle ?? null,
    channelImage: channel?.image ?? null,
    streamKey: v.id,
    title: sn.title,
    category: YT_CATEGORIES[sn.categoryId] || null,
    viewers: Number.parseInt(ls.concurrentViewers, 10) || 0,
    startedAt: ls.actualStartTime ? Math.floor(Date.parse(ls.actualStartTime) / 1000) : null,
    thumbnail: sn.thumbnails?.medium?.url || sn.thumbnails?.high?.url || sn.thumbnails?.default?.url || null,
    adult: v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
  };
}

/** 유튜브 쿼터는 태평양 시간 자정에 초기화된다 */
export function quotaDate(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(ms);
}

/** 일반 객체를 Map 처럼 다루는 래퍼 (상태를 JSON 으로 DB에 저장하기 위해) */
function objMap(o) {
  return {
    has: (k) => Object.hasOwn(o, k),
    get: (k) => o[k],
    set: (k, v) => {
      o[k] = v;
    },
    delete: (k) => {
      delete o[k];
    },
    keys: () => Object.keys(o),
    entries: () => Object.entries(o),
    get size() {
      return Object.keys(o).length;
    },
  };
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function createYoutubeCollector(cfg, { db, state = {}, now = () => Date.now() } = {}) {
  // 서버리스 환경에서도 호출 간에 이어지도록 상태는 state(→ DB kv)에 둔다
  const st = (state.youtube ??= {});
  const quota = (st.quota ??= { date: null, used: 0 });
  const candidates = objMap((st.candidates ??= {})); // videoId → 후보에 추가된 시각
  const skipped = objMap((st.skipped ??= {})); // videoId → 라이브가 아니거나 제외 대상으로 확인된 시각
  const channels = objMap((st.channels ??= {})); // channelId → { image, handle }

  const remaining = () => (quota.date === quotaDate(now()) ? cfg.youtubeDailyQuota - quota.used : cfg.youtubeDailyQuota);
  const spend = (units) => {
    const d = quotaDate(now());
    if (quota.date !== d) {
      quota.date = d;
      quota.used = 0;
    }
    quota.used += units;
  };

  async function call(path, params, cost) {
    if (remaining() < cost) throw new Error(`유튜브 일일 쿼터 소진 (${cfg.youtubeDailyQuota}단위)`);
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    url.searchParams.set('key', cfg.youtubeApiKey);
    spend(cost);
    return fetchJson(url, { retries: 1 });
  }

  function addCandidate(id, t) {
    if (!id || skipped.has(id)) return;
    if (!candidates.has(id)) candidates.set(id, t);
  }

  async function discover(t) {
    let pageToken;
    for (let page = 0; page < cfg.youtubeSearchPages; page++) {
      // 추적용 쿼터는 남겨 둔다
      if (remaining() - 100 < cfg.youtubeQuotaReserve) break;
      const json = await call('/search', {
        part: 'snippet',
        eventType: 'live',
        type: 'video',
        regionCode: cfg.youtubeRegion,
        relevanceLanguage: cfg.youtubeLanguage,
        order: 'viewCount',
        maxResults: 50,
        pageToken,
      }, 100);
      for (const it of json?.items ?? []) addCandidate(it.id?.videoId, t);
      pageToken = json?.nextPageToken;
      if (!pageToken) break;
    }
  }

  async function pollRss(t) {
    for (const group of chunk(cfg.youtubeChannelIds, 5)) {
      await Promise.all(group.map(async (channelId) => {
        try {
          const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { retries: 0 });
          const ids = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].slice(0, 5).map((m) => m[1]);
          for (const id of ids) addCandidate(id, t);
        } catch {
          // 개별 채널 실패는 무시
        }
      }));
    }
  }

  async function loadChannels(ids) {
    const missing = [...new Set(ids)].filter((id) => !channels.has(id));
    for (const group of chunk(missing, 50)) {
      try {
        const json = await call('/channels', { part: 'snippet', id: group.join(','), maxResults: 50 }, 1);
        for (const c of json?.items ?? []) {
          channels.set(c.id, {
            image: c.snippet?.thumbnails?.medium?.url || c.snippet?.thumbnails?.default?.url || null,
            handle: c.snippet?.customUrl || null,
          });
        }
      } catch {
        break;
      }
    }
  }

  const excluded = (v) => {
    if (cfg.youtubeKoreanOnly && !isKorean(v)) return true;
    return cfg.youtubeExcludeCategories.includes(String(v.snippet?.categoryId));
  };

  return {
    id: 'youtube',
    enabled: Boolean(cfg.youtubeApiKey),
    disabledReason: 'YOUTUBE_API_KEY 환경 변수가 필요합니다',
    quota: () => ({ date: quota.date, used: quota.used, remaining: remaining() }),

    async fetchLives() {
      const t = now();
      for (const [id, at] of skipped.entries()) if (t - at > 2 * DAY) skipped.delete(id);
      if (channels.size > 5000) for (const k of channels.keys()) channels.delete(k);

      if (t - (st.lastSearch || 0) >= cfg.youtubeSearchIntervalMin * 60000) {
        st.lastSearch = t;
        await discover(t);
      }
      if (cfg.youtubeChannelIds.length && t - (st.lastRss || 0) >= cfg.youtubeRssIntervalMin * 60000) {
        st.lastRss = t;
        await pollRss(t);
      }

      // 이미 방송 중으로 기록된 영상(재시작 후에도 이어서 추적)
      const open = db
        ? (await all(db, "SELECT stream_key FROM streams WHERE platform = 'youtube' AND ended_at IS NULL")).map((r) => String(r.stream_key))
        : [];
      const ids = [...new Set([...candidates.keys(), ...open])];

      const lives = [];
      for (const group of chunk(ids, 50)) {
        const json = await call('/videos', { part: 'snippet,liveStreamingDetails,contentDetails', id: group.join(','), maxResults: 50 }, 1);
        const returned = new Set();
        for (const v of json?.items ?? []) {
          returned.add(v.id);
          const state = v.snippet?.liveBroadcastContent;
          const isLive = state === 'live' && !v.liveStreamingDetails?.actualEndTime;
          if (!isLive) {
            // 예정된 방송은 계속 지켜보고, 끝났거나 일반 영상이면 후보에서 뺀다
            if (state !== 'upcoming') {
              candidates.delete(v.id);
              skipped.set(v.id, t);
            }
            continue;
          }
          if (excluded(v)) {
            candidates.delete(v.id);
            skipped.set(v.id, t);
            continue;
          }
          addCandidate(v.id, t);
          // 동시 시청자 수를 숨긴 방송은 집계할 수 없다
          if (v.liveStreamingDetails?.concurrentViewers === undefined) continue;
          lives.push(v);
        }
        // 삭제·비공개 처리된 영상
        for (const id of group) if (!returned.has(id)) candidates.delete(id);
      }

      await loadChannels(lives.map((v) => v.snippet?.channelId).filter(Boolean));
      return lives
        .map((v) => normalizeYoutubeVideo(v, st.channels[v.snippet?.channelId]))
        .filter((x) => x.channelId && x.viewers >= cfg.minViewers);
    },

    async fetchFollowers(channelId) {
      const json = await call('/channels', { part: 'statistics', id: channelId }, 1);
      const st = json?.items?.[0]?.statistics;
      if (!st || st.hiddenSubscriberCount) return null;
      return Number.parseInt(st.subscriberCount, 10);
    },
  };
}
