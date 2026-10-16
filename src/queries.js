import { addDays, daysBetween, kstDate, kstDayStart, nowSec } from './util.js';

const SORTS = {
  watch: 'viewer_sec',
  avg: 'avg_viewers',
  peak: 'peak',
  air: 'air_sec',
  followers: 'followers',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** from/to 파라미터 정리 (기본: 최근 7일) */
export function resolveRange(q) {
  const today = kstDate(nowSec());
  let to = DATE_RE.test(q.to || '') ? q.to : today;
  let from = DATE_RE.test(q.from || '') ? q.from : addDays(to, -6);
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) > 3660) from = addDays(to, -3659);
  return { from, to };
}

const clampInt = (v, d, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

function filters(q, alias = 'd') {
  const where = [];
  const params = [];
  if (q.platform && q.platform !== 'all') {
    where.push(`${alias}.platform = ?`);
    params.push(q.platform);
  }
  if (q.category) {
    where.push(`${alias}.category = ?`);
    params.push(q.category);
  }
  return { where, params };
}

function mainCategories(db, channels, from, to) {
  if (!channels.length) return new Map();
  const stmt = db.prepare(`
    SELECT category, SUM(viewer_sec) vs FROM daily
    WHERE platform = ? AND channel_id = ? AND date BETWEEN ? AND ?
    GROUP BY category ORDER BY vs DESC LIMIT 1`);
  const map = new Map();
  for (const c of channels) map.set(`${c.platform}:${c.channel_id}`, stmt.get(c.platform, c.channel_id, from, to)?.category ?? null);
  return map;
}

function liveMap(db, channels) {
  const map = new Map();
  if (!channels.length) return map;
  const stmt = db.prepare(`
    SELECT id, current_viewers, title, category FROM streams
    WHERE platform = ? AND channel_id = ? AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`);
  for (const c of channels) {
    const r = stmt.get(c.platform, c.channel_id);
    if (r) map.set(`${c.platform}:${c.channel_id}`, r);
  }
  return map;
}

function rankingAggregate(q, from, to) {
  const { where, params } = filters(q);
  return {
    sql: `
      SELECT d.platform, d.channel_id,
        SUM(d.viewer_sec) viewer_sec, SUM(d.air_sec) air_sec, MAX(d.peak) peak,
        CAST(ROUND(SUM(d.viewer_sec) * 1.0 / NULLIF(SUM(d.air_sec), 0)) AS INTEGER) avg_viewers,
        COUNT(DISTINCT d.date) days
      FROM daily d
      WHERE d.date BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
      GROUP BY d.platform, d.channel_id`,
    params: [from, to, ...params],
  };
}

/** 스트리머 랭킹 (기간·플랫폼·카테고리·정렬 기준) + 직전 동일 기간 대비 순위 변동 */
export function rankings(db, q) {
  const { from, to } = resolveRange(q);
  const sortKey = SORTS[q.sort] ? q.sort : 'watch';
  const sortCol = SORTS[sortKey];
  const limit = clampInt(q.limit, 50, 1, 500);
  const offset = clampInt(q.offset, 0, 0, 100000);
  const search = (q.q || '').trim();

  const agg = rankingAggregate(q, from, to);
  const base = `
    WITH agg AS (${agg.sql}),
    ranked AS (
      SELECT agg.*, c.name, c.login, c.image_url, c.followers,
        ROW_NUMBER() OVER (ORDER BY ${sortCol === 'followers' ? 'COALESCE(c.followers, 0)' : 'agg.' + sortCol} DESC, agg.viewer_sec DESC) rank
      FROM agg LEFT JOIN channels c ON c.platform = agg.platform AND c.channel_id = agg.channel_id
    )`;
  const searchSql = search ? 'WHERE (name LIKE ? OR login LIKE ? OR channel_id = ?)' : '';
  const searchParams = search ? [`%${search}%`, `%${search}%`, search] : [];

  const rows = db.prepare(`${base} SELECT * FROM ranked ${searchSql} ORDER BY rank LIMIT ? OFFSET ?`)
    .all(...agg.params, ...searchParams, limit, offset);
  const total = db.prepare(`${base} SELECT COUNT(*) n FROM ranked ${searchSql}`).get(...agg.params, ...searchParams).n;

  // 직전 동일 길이 기간 순위
  const span = daysBetween(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  const prevAgg = rankingAggregate(q, prevFrom, prevTo);
  const prevRanks = new Map();
  if (rows.length) {
    const prev = db.prepare(`
      WITH agg AS (${prevAgg.sql})
      SELECT platform, channel_id, ROW_NUMBER() OVER (ORDER BY ${sortCol === 'followers' ? 'viewer_sec' : sortCol} DESC, viewer_sec DESC) rank FROM agg`)
      .all(...prevAgg.params);
    for (const p of prev) prevRanks.set(`${p.platform}:${p.channel_id}`, p.rank);
  }

  const cats = mainCategories(db, rows, from, to);
  const lives = liveMap(db, rows);
  return {
    from, to, sort: sortKey, total, limit, offset,
    previous: { from: prevFrom, to: prevTo },
    items: rows.map((r) => {
      const key = `${r.platform}:${r.channel_id}`;
      const live = lives.get(key);
      return {
        rank: r.rank,
        prevRank: prevRanks.get(key) ?? null,
        platform: r.platform,
        channelId: r.channel_id,
        name: r.name,
        login: r.login,
        image: r.image_url,
        followers: r.followers,
        avgViewers: r.avg_viewers ?? 0,
        peakViewers: r.peak,
        watchHours: r.viewer_sec / 3600,
        airHours: r.air_sec / 3600,
        days: r.days,
        mainCategory: cats.get(key),
        live: live ? { streamId: live.id, viewers: live.current_viewers, title: live.title, category: live.category } : null,
      };
    }),
  };
}

/** 지금 방송 중인 목록 */
export function liveNow(db, q, cfg) {
  const limit = clampInt(q.limit, 60, 1, 500);
  const offset = clampInt(q.offset, 0, 0, 100000);
  const where = ['s.ended_at IS NULL', 's.last_seen_at >= ?'];
  const params = [nowSec() - cfg.intervalSec * 3];
  if (q.platform && q.platform !== 'all') {
    where.push('s.platform = ?');
    params.push(q.platform);
  }
  if (q.category) {
    where.push('s.category = ?');
    params.push(q.category);
  }
  if (q.q) {
    where.push('(c.name LIKE ? OR s.title LIKE ? OR c.login LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const from = `FROM streams s LEFT JOIN channels c ON c.platform = s.platform AND c.channel_id = s.channel_id WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(`
    SELECT s.id, s.platform, s.channel_id, s.title, s.category, s.thumbnail, s.adult, s.started_at, s.current_viewers, s.peak_viewers,
      c.name, c.image_url, c.followers
    ${from} ORDER BY s.current_viewers DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(s.current_viewers), 0) v ${from}`).get(...params);
  const categories = db.prepare(`
    SELECT s.category, COUNT(*) channels, SUM(s.current_viewers) viewers
    FROM streams s WHERE s.ended_at IS NULL AND s.last_seen_at >= ? ${q.platform && q.platform !== 'all' ? 'AND s.platform = ?' : ''}
    GROUP BY s.category ORDER BY viewers DESC LIMIT 30`)
    .all(...[params[0], ...(q.platform && q.platform !== 'all' ? [q.platform] : [])]);
  return {
    total: total.n,
    totalViewers: total.v,
    categories,
    items: rows.map(mapLiveRow),
  };
}

function mapLiveRow(r) {
  return {
    streamId: r.id,
    platform: r.platform,
    channelId: r.channel_id,
    name: r.name,
    image: r.image_url,
    title: r.title,
    category: r.category,
    thumbnail: r.thumbnail,
    adult: !!r.adult,
    startedAt: r.started_at,
    viewers: r.current_viewers,
    peakViewers: r.peak_viewers,
    followers: r.followers,
  };
}

/** 홈 화면: 플랫폼별 현재 시청자, 24시간 추이, 인기 방송, 인기 카테고리 */
export function overview(db, cfg) {
  const now = nowSec();
  const fresh = now - cfg.intervalSec * 3;
  const platforms = db.prepare(`
    SELECT p.platform, p.ts, p.viewers, p.channels FROM platform_snapshots p
    JOIN (SELECT platform, MAX(ts) ts FROM platform_snapshots WHERE ts >= ? GROUP BY platform) l
      ON l.platform = p.platform AND l.ts = p.ts`).all(fresh);

  // 24시간 전 같은 시각 대비 변화
  const dayAgo = db.prepare(`
    SELECT viewers FROM platform_snapshots WHERE platform = ? AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) LIMIT 1`);
  for (const p of platforms) {
    const t = p.ts - 86400;
    p.viewersDayAgo = dayAgo.get(p.platform, t - cfg.intervalSec * 2, t + cfg.intervalSec * 2, t)?.viewers ?? null;
  }

  const trend = db.prepare('SELECT platform, ts, viewers, channels FROM platform_snapshots WHERE ts >= ? ORDER BY ts')
    .all(now - 86400 - cfg.intervalSec);

  const top = db.prepare(`
    SELECT s.id, s.platform, s.channel_id, s.title, s.category, s.thumbnail, s.adult, s.started_at, s.current_viewers, s.peak_viewers,
      c.name, c.image_url, c.followers
    FROM streams s LEFT JOIN channels c ON c.platform = s.platform AND c.channel_id = s.channel_id
    WHERE s.ended_at IS NULL AND s.last_seen_at >= ? ORDER BY s.current_viewers DESC LIMIT 12`).all(fresh).map(mapLiveRow);

  const categories = db.prepare(`
    SELECT category, COUNT(*) channels, SUM(current_viewers) viewers FROM streams
    WHERE ended_at IS NULL AND last_seen_at >= ? GROUP BY category ORDER BY viewers DESC LIMIT 10`).all(fresh);

  const today = kstDate(now);
  const todayStats = db.prepare(`
    SELECT COUNT(DISTINCT platform || ':' || channel_id) channels, COALESCE(SUM(viewer_sec), 0) viewer_sec FROM daily WHERE date = ?`).get(today);

  const totals = db.prepare('SELECT COUNT(*) channels FROM channels').get();
  const firstDate = db.prepare('SELECT MIN(date) d FROM daily').get()?.d ?? null;

  return {
    now,
    platforms,
    trend,
    top,
    categories,
    today: { date: today, channels: todayStats.channels, watchHours: todayStats.viewer_sec / 3600 },
    trackedChannels: totals.channels,
    since: firstDate,
  };
}

/** 카테고리 랭킹 */
export function categories(db, q) {
  const { from, to } = resolveRange(q);
  const { where, params } = filters({ platform: q.platform });
  const limit = clampInt(q.limit, 100, 1, 1000);
  const search = (q.q || '').trim();
  const rows = db.prepare(`
    SELECT d.category, SUM(d.viewer_sec) viewer_sec, SUM(d.air_sec) air_sec, MAX(d.peak) peak,
      COUNT(DISTINCT d.platform || ':' || d.channel_id) channels,
      SUM(CASE WHEN d.platform = 'chzzk' THEN d.viewer_sec ELSE 0 END) chzzk_sec,
      SUM(CASE WHEN d.platform = 'soop' THEN d.viewer_sec ELSE 0 END) soop_sec,
      SUM(CASE WHEN d.platform = 'twitch' THEN d.viewer_sec ELSE 0 END) twitch_sec
    FROM daily d WHERE d.date BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ${search ? 'AND d.category LIKE ?' : ''}
    GROUP BY d.category ORDER BY viewer_sec DESC LIMIT ?`).all(from, to, ...params, ...(search ? [`%${search}%`] : []), limit);
  const totalSec = rows.reduce((a, r) => a + r.viewer_sec, 0) || 1;
  const hours = daysBetween(from, to) * 24;
  return {
    from, to,
    items: rows.map((r, i) => ({
      rank: i + 1,
      category: r.category,
      watchHours: r.viewer_sec / 3600,
      airHours: r.air_sec / 3600,
      // 기간 전체 시간 대비 평균 동시 시청자
      avgConcurrent: Math.round(r.viewer_sec / 3600 / hours),
      avgPerStream: r.air_sec ? Math.round(r.viewer_sec / r.air_sec) : 0,
      peak: r.peak,
      channels: r.channels,
      share: r.viewer_sec / totalSec,
      byPlatform: { chzzk: r.chzzk_sec / 3600, soop: r.soop_sec / 3600, twitch: r.twitch_sec / 3600 },
    })),
  };
}

/** 카테고리 상세 */
export function categoryDetail(db, name, q) {
  const { from, to } = resolveRange(q);
  const daily = db.prepare(`
    SELECT date, platform, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, COUNT(DISTINCT channel_id) channels
    FROM daily WHERE category = ? AND date BETWEEN ? AND ? GROUP BY date, platform ORDER BY date`).all(name, from, to);
  const top = rankings(db, { ...q, from, to, category: name, limit: q.limit || 30 });
  const channels = db.prepare(`
    SELECT COUNT(DISTINCT platform || ':' || channel_id) n FROM daily WHERE category = ? AND date BETWEEN ? AND ?`).get(name, from, to).n;
  return {
    category: name, from, to, channels,
    daily: daily.map((d) => ({ date: d.date, platform: d.platform, watchHours: d.viewer_sec / 3600, airHours: d.air_sec / 3600, channels: d.channels })),
    top: top.items,
  };
}

/** 플랫폼 비교: 일자별 시청 시간 · 동시 시청자 */
export function platformsStats(db, q) {
  const { from, to } = resolveRange(q);
  const daily = db.prepare(`
    SELECT date, platform, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, COUNT(DISTINCT channel_id) channels
    FROM daily WHERE date BETWEEN ? AND ? GROUP BY date, platform ORDER BY date`).all(from, to);
  const concurrent = db.prepare(`
    SELECT date(ts + 32400, 'unixepoch') date, platform, CAST(AVG(viewers) AS INTEGER) avg, MAX(viewers) peak
    FROM platform_snapshots WHERE ts BETWEEN ? AND ? GROUP BY date, platform ORDER BY date`)
    .all(kstDayStart(from), kstDayStart(addDays(to, 1)) - 1);
  const cmap = new Map(concurrent.map((c) => [`${c.date}:${c.platform}`, c]));
  const totals = {};
  for (const d of daily) {
    const t = (totals[d.platform] ??= { platform: d.platform, watchHours: 0, airHours: 0, peak: 0, avgSum: 0, avgDays: 0 });
    t.watchHours += d.viewer_sec / 3600;
    t.airHours += d.air_sec / 3600;
    const c = cmap.get(`${d.date}:${d.platform}`);
    if (c) {
      t.peak = Math.max(t.peak, c.peak);
      t.avgSum += c.avg;
      t.avgDays += 1;
    }
  }
  const channels = db.prepare(`
    SELECT platform, COUNT(DISTINCT channel_id) channels FROM daily WHERE date BETWEEN ? AND ? GROUP BY platform`).all(from, to);
  for (const c of channels) if (totals[c.platform]) totals[c.platform].channels = c.channels;

  // 시간대별 평균 동시 시청자 (KST)
  const hourly = db.prepare(`
    SELECT CAST(strftime('%H', ts + 32400, 'unixepoch') AS INTEGER) hour, platform, CAST(AVG(viewers) AS INTEGER) viewers
    FROM platform_snapshots WHERE ts BETWEEN ? AND ? GROUP BY hour, platform ORDER BY hour`)
    .all(kstDayStart(from), kstDayStart(addDays(to, 1)) - 1);

  return {
    from, to,
    totals: Object.values(totals).map((t) => ({
      platform: t.platform,
      watchHours: t.watchHours,
      airHours: t.airHours,
      channels: t.channels ?? 0,
      peakConcurrent: t.peak,
      avgConcurrent: t.avgDays ? Math.round(t.avgSum / t.avgDays) : 0,
    })),
    daily: daily.map((d) => {
      const c = cmap.get(`${d.date}:${d.platform}`);
      return {
        date: d.date, platform: d.platform, watchHours: d.viewer_sec / 3600, airHours: d.air_sec / 3600, channels: d.channels,
        avgConcurrent: c?.avg ?? null, peakConcurrent: c?.peak ?? null,
      };
    }),
    hourly,
  };
}

export function searchChannels(db, q) {
  const s = (q.q || '').trim();
  if (!s) return { items: [] };
  const limit = clampInt(q.limit, 10, 1, 50);
  const rows = db.prepare(`
    SELECT c.platform, c.channel_id, c.name, c.login, c.image_url, c.followers, c.last_live_at,
      (SELECT current_viewers FROM streams s WHERE s.platform = c.platform AND s.channel_id = c.channel_id AND s.ended_at IS NULL LIMIT 1) live_viewers
    FROM channels c
    WHERE c.name LIKE ? OR c.login LIKE ? OR c.channel_id = ?
    ORDER BY (c.name = ?) DESC, (live_viewers IS NOT NULL) DESC, COALESCE(c.followers, 0) DESC, c.last_live_at DESC
    LIMIT ?`).all(`%${s}%`, `%${s}%`, s, s, limit);
  return {
    items: rows.map((r) => ({
      platform: r.platform, channelId: r.channel_id, name: r.name, login: r.login, image: r.image_url,
      followers: r.followers, lastLiveAt: r.last_live_at, liveViewers: r.live_viewers,
    })),
  };
}

/** 스트리머 상세 */
export function channelDetail(db, platform, channelId, q) {
  const ch = db.prepare('SELECT * FROM channels WHERE platform = ? AND channel_id = ?').get(platform, channelId);
  if (!ch) return null;
  const { from, to } = resolveRange(q);

  const summary = db.prepare(`
    SELECT COALESCE(SUM(viewer_sec), 0) viewer_sec, COALESCE(SUM(air_sec), 0) air_sec, COALESCE(MAX(peak), 0) peak, COUNT(DISTINCT date) days
    FROM daily WHERE platform = ? AND channel_id = ? AND date BETWEEN ? AND ?`).get(platform, channelId, from, to);
  const streamsCount = db.prepare(`
    SELECT COUNT(*) n FROM streams WHERE platform = ? AND channel_id = ? AND started_at BETWEEN ? AND ?`)
    .get(platform, channelId, kstDayStart(from), kstDayStart(addDays(to, 1)) - 1).n;

  // 플랫폼 내 순위 (시청 시간 기준)
  const rank = db.prepare(`
    WITH agg AS (SELECT channel_id, SUM(viewer_sec) vs FROM daily WHERE platform = ? AND date BETWEEN ? AND ? GROUP BY channel_id)
    SELECT (SELECT COUNT(*) FROM agg WHERE vs > a.vs) + 1 rank, (SELECT COUNT(*) FROM agg) total FROM agg a WHERE channel_id = ?`)
    .get(platform, from, to, channelId);

  const daily = db.prepare(`
    SELECT date, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, MAX(peak) peak
    FROM daily WHERE platform = ? AND channel_id = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`).all(platform, channelId, from, to);

  const cats = db.prepare(`
    SELECT category, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, MAX(peak) peak
    FROM daily WHERE platform = ? AND channel_id = ? AND date BETWEEN ? AND ? GROUP BY category ORDER BY air_sec DESC`).all(platform, channelId, from, to);

  // 요일 × 시간대 방송 패턴 (KST)
  const heat = db.prepare(`
    SELECT CAST(strftime('%w', ts + 32400, 'unixepoch') AS INTEGER) dow, CAST(strftime('%H', ts + 32400, 'unixepoch') AS INTEGER) hour,
      SUM(dur) air_sec, SUM(viewers * dur) viewer_sec
    FROM snapshots WHERE platform = ? AND channel_id = ? AND ts BETWEEN ? AND ? GROUP BY dow, hour`)
    .all(platform, channelId, kstDayStart(from), kstDayStart(addDays(to, 1)) - 1);

  const followers = db.prepare(`
    SELECT date, followers FROM follower_history WHERE platform = ? AND channel_id = ? AND date BETWEEN ? AND ? ORDER BY date`)
    .all(platform, channelId, addDays(from, -1), to);

  const streams = db.prepare(`
    SELECT id, title, category, thumbnail, started_at, ended_at, last_seen_at, current_viewers, peak_viewers, viewer_sec, air_sec
    FROM streams WHERE platform = ? AND channel_id = ? AND started_at BETWEEN ? AND ? ORDER BY started_at DESC LIMIT 200`)
    .all(platform, channelId, kstDayStart(from), kstDayStart(addDays(to, 1)) - 1);

  const live = db.prepare(`
    SELECT id, title, category, thumbnail, started_at, current_viewers, peak_viewers FROM streams
    WHERE platform = ? AND channel_id = ? AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`).get(platform, channelId);

  return {
    from, to,
    channel: {
      platform: ch.platform, channelId: ch.channel_id, name: ch.name, login: ch.login, image: ch.image_url,
      followers: ch.followers, firstSeenAt: ch.first_seen_at, lastLiveAt: ch.last_live_at,
    },
    live: live ? { streamId: live.id, title: live.title, category: live.category, thumbnail: live.thumbnail, startedAt: live.started_at, viewers: live.current_viewers, peakViewers: live.peak_viewers } : null,
    summary: {
      avgViewers: summary.air_sec ? Math.round(summary.viewer_sec / summary.air_sec) : 0,
      peakViewers: summary.peak,
      watchHours: summary.viewer_sec / 3600,
      airHours: summary.air_sec / 3600,
      days: summary.days,
      streams: streamsCount,
      rank: rank?.rank ?? null,
      rankTotal: rank?.total ?? null,
    },
    daily: daily.map((d) => ({
      date: d.date, avgViewers: d.air_sec ? Math.round(d.viewer_sec / d.air_sec) : 0, peakViewers: d.peak,
      watchHours: d.viewer_sec / 3600, airHours: d.air_sec / 3600,
    })),
    categories: cats.map((c) => ({
      category: c.category, airHours: c.air_sec / 3600, watchHours: c.viewer_sec / 3600,
      avgViewers: c.air_sec ? Math.round(c.viewer_sec / c.air_sec) : 0, peakViewers: c.peak,
    })),
    heatmap: heat.map((h) => ({ dow: h.dow, hour: h.hour, airHours: h.air_sec / 3600, avgViewers: h.air_sec ? Math.round(h.viewer_sec / h.air_sec) : 0 })),
    followers,
    streams: streams.map(mapStream),
  };
}

function mapStream(s) {
  return {
    id: s.id, title: s.title, category: s.category, thumbnail: s.thumbnail, startedAt: s.started_at,
    endedAt: s.ended_at, lastSeenAt: s.last_seen_at, live: s.ended_at === null,
    avgViewers: s.air_sec ? Math.round(s.viewer_sec / s.air_sec) : 0, peakViewers: s.peak_viewers,
    watchHours: s.viewer_sec / 3600, airHours: s.air_sec / 3600,
  };
}

/** 방송(라이브 1회) 상세: 시청자 타임라인과 카테고리 변경 구간 */
export function streamDetail(db, id) {
  const s = db.prepare('SELECT * FROM streams WHERE id = ?').get(id);
  if (!s) return null;
  const ch = db.prepare('SELECT * FROM channels WHERE platform = ? AND channel_id = ?').get(s.platform, s.channel_id);
  const timeline = db.prepare('SELECT ts, viewers, category FROM snapshots WHERE stream_id = ? ORDER BY ts').all(id);
  const segments = [];
  for (const t of timeline) {
    const last = segments.at(-1);
    if (last && last.category === t.category) last.to = t.ts;
    else segments.push({ category: t.category, from: t.ts, to: t.ts });
  }
  const prevNext = db.prepare(`
    SELECT
      (SELECT id FROM streams WHERE platform = ? AND channel_id = ? AND started_at < ? ORDER BY started_at DESC LIMIT 1) prev,
      (SELECT id FROM streams WHERE platform = ? AND channel_id = ? AND started_at > ? ORDER BY started_at ASC LIMIT 1) next`)
    .get(s.platform, s.channel_id, s.started_at, s.platform, s.channel_id, s.started_at);
  // 채널 평균 대비 (최근 30일)
  const since = s.started_at - 30 * 86400;
  const channelAvg = db.prepare(`
    SELECT SUM(viewer_sec) vs, SUM(air_sec) a FROM streams WHERE platform = ? AND channel_id = ? AND started_at BETWEEN ? AND ? AND id != ?`)
    .get(s.platform, s.channel_id, since, s.started_at, id);
  return {
    stream: { ...mapStream(s), platform: s.platform, channelId: s.channel_id, currentViewers: s.current_viewers, adult: !!s.adult },
    channel: ch ? { platform: ch.platform, channelId: ch.channel_id, name: ch.name, image: ch.image_url, followers: ch.followers } : null,
    timeline,
    segments,
    prevId: prevNext.prev,
    nextId: prevNext.next,
    channelAvgViewers: channelAvg?.a ? Math.round(channelAvg.vs / channelAvg.a) : null,
  };
}

/** 여러 스트리머 비교 */
export function compare(db, ids, q) {
  const { from, to } = resolveRange(q);
  const items = [];
  for (const raw of ids.slice(0, 6)) {
    const [platform, ...rest] = raw.split(':');
    const channelId = rest.join(':');
    const d = channelDetail(db, platform, channelId, { from, to });
    if (d) items.push({ channel: d.channel, live: d.live, summary: d.summary, daily: d.daily, categories: d.categories.slice(0, 5), heatmap: d.heatmap });
  }
  return { from, to, items };
}

/** 즐겨찾기 등 여러 채널의 현재 상태 + 기간 요약 (최대 100개) */
export function channelsBatch(db, ids, q) {
  const { from, to } = resolveRange(q);
  const getCh = db.prepare('SELECT * FROM channels WHERE platform = ? AND channel_id = ?');
  const getSum = db.prepare(`
    SELECT COALESCE(SUM(viewer_sec), 0) vs, COALESCE(SUM(air_sec), 0) a, COALESCE(MAX(peak), 0) peak
    FROM daily WHERE platform = ? AND channel_id = ? AND date BETWEEN ? AND ?`);
  const getLive = db.prepare(`
    SELECT id, title, category, current_viewers, started_at FROM streams
    WHERE platform = ? AND channel_id = ? AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`);
  const items = [];
  for (const raw of ids.slice(0, 100)) {
    const [platform, ...rest] = raw.split(':');
    const channelId = rest.join(':');
    const ch = getCh.get(platform, channelId);
    if (!ch) continue;
    const sm = getSum.get(platform, channelId, from, to);
    const live = getLive.get(platform, channelId);
    items.push({
      platform, channelId, name: ch.name, login: ch.login, image: ch.image_url, followers: ch.followers, lastLiveAt: ch.last_live_at,
      live: live ? { streamId: live.id, title: live.title, category: live.category, viewers: live.current_viewers, startedAt: live.started_at } : null,
      avgViewers: sm.a ? Math.round(sm.vs / sm.a) : 0, peakViewers: sm.peak, airHours: sm.a / 3600, watchHours: sm.vs / 3600,
    });
  }
  return { from, to, items };
}

export function status(db, cfg) {
  const rows = db.prepare('SELECT * FROM collector_status').all();
  const counts = db.prepare(`
    SELECT (SELECT COUNT(*) FROM channels) channels, (SELECT COUNT(*) FROM streams) streams,
      (SELECT COUNT(*) FROM snapshots) snapshots, (SELECT MIN(date) FROM daily) since`).get();
  return {
    demo: cfg.demo,
    intervalSec: cfg.intervalSec,
    minViewers: cfg.minViewers,
    collectorEnabled: cfg.enableCollector,
    platforms: rows.map((r) => ({
      platform: r.platform, lastRunAt: r.last_run_at, lastSuccessAt: r.last_success_at, lastError: r.last_error,
      liveCount: r.live_count, totalViewers: r.total_viewers, durationMs: r.duration_ms,
    })),
    ...counts,
  };
}
