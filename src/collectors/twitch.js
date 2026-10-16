import { fetchJson } from '../util.js';

/**
 * 트위치 Helix API (앱 액세스 토큰, client credentials)
 *  - 라이브 목록: GET /helix/streams?language=ko&first=100&after=cursor
 *  - 프로필:     GET /helix/users?id=...
 *  - 팔로워:     GET /helix/channels/followers?broadcaster_id=... → total
 */
export function normalizeTwitchStream(s) {
  return {
    channelId: s.user_id,
    login: s.user_login,
    channelName: s.user_name || s.user_login,
    channelImage: null,
    streamKey: s.id,
    title: s.title,
    category: s.game_name || null,
    viewers: s.viewer_count ?? 0,
    startedAt: s.started_at ? Math.floor(Date.parse(s.started_at) / 1000) : null,
    thumbnail: s.thumbnail_url ? s.thumbnail_url.replace('{width}', '480').replace('{height}', '270') : null,
    adult: !!s.is_mature,
  };
}

export function createTwitchCollector(cfg, { state = {} } = {}) {
  // 토큰과 프로필 이미지 캐시는 state(→ DB kv)에 두어 서버리스 호출 간에 재사용
  const st = (state.twitch ??= {});
  if (Object.keys(st.images ?? {}).length > 5000) st.images = {};
  const images = (st.images ??= {});

  async function auth() {
    if (st.token && Date.now() < st.tokenExp - 60000) return st.token;
    const url = new URL('https://id.twitch.tv/oauth2/token');
    url.searchParams.set('client_id', cfg.twitchClientId);
    url.searchParams.set('client_secret', cfg.twitchClientSecret);
    url.searchParams.set('grant_type', 'client_credentials');
    const json = await fetchJson(url, { method: 'POST' });
    st.token = json.access_token;
    st.tokenExp = Date.now() + (json.expires_in || 3600) * 1000;
    return st.token;
  }
  const helix = async (path) => {
    const t = await auth();
    return fetchJson(`https://api.twitch.tv/helix${path}`, { headers: { 'Client-Id': cfg.twitchClientId, Authorization: `Bearer ${t}` } });
  };

  return {
    id: 'twitch',
    enabled: Boolean(cfg.twitchClientId && cfg.twitchClientSecret),
    disabledReason: 'TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET 환경 변수가 필요합니다',
    async fetchLives() {
      const out = [];
      let cursor = null;
      for (let page = 0; page < cfg.maxPages; page++) {
        const qs = new URLSearchParams({ language: cfg.twitchLanguage, first: '100' });
        if (cursor) qs.set('after', cursor);
        const json = await helix(`/streams?${qs}`);
        const data = json?.data ?? [];
        for (const s of data) out.push(normalizeTwitchStream(s));
        cursor = json?.pagination?.cursor;
        const last = data.at(-1);
        if (!cursor || !data.length || (last && last.viewer_count < cfg.minViewers)) break;
      }
      const lives = out.filter((x) => x.viewers >= cfg.minViewers);

      // 프로필 이미지는 100명 단위로 조회하고 캐시
      const missing = [...new Set(lives.map((l) => l.channelId).filter((id) => !Object.hasOwn(images, id)))];
      for (let i = 0; i < missing.length; i += 100) {
        const qs = missing.slice(i, i + 100).map((id) => `id=${id}`).join('&');
        try {
          const json = await helix(`/users?${qs}`);
          for (const u of json?.data ?? []) images[u.id] = u.profile_image_url;
        } catch {
          break;
        }
      }
      for (const l of lives) l.channelImage = images[l.channelId] ?? null;
      return lives;
    },
    async fetchFollowers(channelId) {
      const json = await helix(`/channels/followers?broadcaster_id=${encodeURIComponent(channelId)}&first=1`);
      return json?.total ?? null;
    },
  };
}
