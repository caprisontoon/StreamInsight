import { fetchJson, parseKst } from '../util.js';

/**
 * SOOP(구 아프리카TV) 공개 API
 *  - 라이브 목록: GET main_broad_list_api.php?selectType=action&orderType=view_cnt&pageNo=N  (페이지당 60개)
 *  - 방송국 정보: GET chapi.sooplive.co.kr/api/{userId}/station → station.upd.fan_cnt
 */
export function soopProfileImage(userId) {
  if (!userId) return null;
  return `https://profile.img.sooplive.co.kr/LOGO/${userId.slice(0, 2)}/${userId}/${userId}.jpg`;
}

export function normalizeSoopLive(b) {
  const tags = Array.isArray(b.category_tags) ? b.category_tags : [];
  let thumb = b.broad_thumb || null;
  if (thumb && thumb.startsWith('//')) thumb = `https:${thumb}`;
  return {
    channelId: b.user_id,
    login: b.user_id,
    channelName: b.user_nick,
    channelImage: soopProfileImage(b.user_id),
    streamKey: b.broad_no,
    title: b.broad_title,
    category: tags[0] || b.category_name || null,
    viewers: Number.parseInt(b.total_view_cnt, 10) || 0,
    startedAt: parseKst(b.broad_start),
    thumbnail: thumb,
    adult: String(b.broad_grade) === '19',
  };
}

export function createSoopCollector(cfg) {
  return {
    id: 'soop',
    async fetchLives() {
      const out = [];
      for (let page = 1; page <= cfg.maxPages; page++) {
        const url = new URL(cfg.soopListApi);
        url.searchParams.set('selectType', 'action');
        url.searchParams.set('selectValue', 'all');
        url.searchParams.set('orderType', 'view_cnt');
        url.searchParams.set('pageNo', String(page));
        url.searchParams.set('lang', 'ko_KR');
        const json = await fetchJson(url, { headers: { Referer: 'https://www.sooplive.co.kr/' } });
        const list = json?.broad ?? [];
        for (const b of list) out.push(normalizeSoopLive(b));
        const last = list.at(-1);
        if (!list.length || (last && (Number.parseInt(last.total_view_cnt, 10) || 0) < cfg.minViewers)) break;
      }
      return out.filter((x) => x.viewers >= cfg.minViewers);
    },
    async fetchFollowers(channelId) {
      const json = await fetchJson(`${cfg.soopStationApi}/${encodeURIComponent(channelId)}/station`, {
        retries: 1,
        headers: { Referer: 'https://www.sooplive.co.kr/' },
      });
      return json?.station?.upd?.fan_cnt ?? null;
    },
  };
}
