import { fetchJson, parseKst } from '../util.js';

/**
 * 치지직 공개 API
 *  - 라이브 목록: GET /service/v1/lives?size=50&sortType=POPULAR (커서: concurrentUserCount + liveId)
 *  - 채널 정보:   GET /service/v1/channels/{channelId}  → followerCount
 */
export function normalizeChzzkLive(d) {
  const ch = d.channel || {};
  const thumb = d.liveImageUrl ? d.liveImageUrl.replace('{type}', '480') : d.defaultThumbnailImageUrl || null;
  return {
    channelId: ch.channelId,
    channelName: ch.channelName,
    channelImage: ch.channelImageUrl || null,
    streamKey: d.liveId,
    title: d.liveTitle,
    category: d.liveCategoryValue || d.liveCategory || null,
    viewers: d.concurrentUserCount ?? 0,
    startedAt: parseKst(d.openDate),
    thumbnail: thumb,
    adult: !!d.adult,
  };
}

export function createChzzkCollector(cfg) {
  const base = cfg.chzzkApiBase;
  return {
    id: 'chzzk',
    async fetchLives() {
      const out = [];
      let next = null;
      for (let page = 0; page < cfg.maxPages; page++) {
        const url = new URL('/service/v1/lives', base);
        url.searchParams.set('size', '50');
        url.searchParams.set('sortType', 'POPULAR');
        if (next) {
          url.searchParams.set('concurrentUserCount', String(next.concurrentUserCount));
          url.searchParams.set('liveId', String(next.liveId));
        }
        const json = await fetchJson(url);
        const data = json?.content?.data ?? [];
        for (const d of data) out.push(normalizeChzzkLive(d));
        next = json?.content?.page?.next;
        const last = data.at(-1);
        if (!next || !data.length || (last && last.concurrentUserCount < cfg.minViewers)) break;
      }
      return out.filter((x) => x.viewers >= cfg.minViewers);
    },
    async fetchFollowers(channelId) {
      const json = await fetchJson(new URL(`/service/v1/channels/${encodeURIComponent(channelId)}`, base), { retries: 1 });
      return json?.content?.followerCount ?? null;
    },
  };
}
