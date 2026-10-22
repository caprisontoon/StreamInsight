import { all, get } from './db.js';
import { parseTimeline } from './ingest.js';
import { KST_OFFSET, addDays, daysBetween, kstDate, kstDayStart, nowSec } from './util.js';

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

const hasPlatform = (p) => p && p !== 'all';

/** 여러 읽기 쿼리를 한 번의 왕복으로 실행 */
async function readBatch(db, stmts) {
  if (!stmts.length) return [];
  return (await db.batch(stmts, 'read')).map((r) => r.rows);
}

/**
 * 일자 × 채널 × 카테고리 집계 = 끝난 방송(daily) + 방송 중인 방송(streams.day_stats)
 * 조건은 두 쪽에 모두 적용해 필요한 행만 읽는다.
 */
function dailyRows({ from, to, platform, channelId, category }) {
  const w1 = ['date BETWEEN ? AND ?'];
  const p1 = [from, to];
  const w2 = ['s.ended_at IS NULL', 'substr(j.key, 1, 10) BETWEEN ? AND ?'];
  const p2 = [from, to];
  if (hasPlatform(platform)) {
    w1.push('platform = ?');
    p1.push(platform);
    w2.push('s.platform = ?');
    p2.push(platform);
  }
  if (channelId) {
    w1.push('channel_id = ?');
    p1.push(channelId);
    w2.push('s.channel_id = ?');
    p2.push(channelId);
  }
  if (category) {
    w1.push('category = ?');
    p1.push(category);
    w2.push('substr(j.key, 12) = ?');
    p2.push(category);
  }
  return {
    sql: `(
      SELECT date, platform, channel_id, category, viewer_sec, air_sec, peak FROM daily WHERE ${w1.join(' AND ')}
      UNION ALL
      SELECT substr(j.key, 1, 10) AS date, s.platform, s.channel_id, substr(j.key, 12) AS category,
        json_extract(j.value, '$[0]') AS viewer_sec, json_extract(j.value, '$[1]') AS air_sec, json_extract(j.value, '$[2]') AS peak
      FROM streams s, json_each(s.day_stats) j WHERE ${w2.join(' AND ')}
    )`,
    args: [...p1, ...p2],
  };
}

function rankingAggregate(q, from, to) {
  const src = dailyRows({ from, to, platform: q.platform, category: q.category });
  return {
    sql: `
      SELECT platform, channel_id,
        SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, MAX(peak) peak,
        CAST(ROUND(SUM(viewer_sec) * 1.0 / NULLIF(SUM(air_sec), 0)) AS INTEGER) avg_viewers,
        COUNT(DISTINCT date) days
      FROM ${src.sql}
      GROUP BY platform, channel_id`,
    args: src.args,
  };
}

/** 랭킹 결과 채널들의 주 카테고리와 방송 중 여부 */
async function enrichChannels(db, rows, from, to) {
  const stmts = [];
  for (const c of rows) {
    const src = dailyRows({ from, to, platform: c.platform, channelId: c.channel_id });
    stmts.push({ sql: `SELECT category, SUM(viewer_sec) vs FROM ${src.sql} GROUP BY category ORDER BY vs DESC LIMIT 1`, args: src.args });
    stmts.push({
      sql: `SELECT id, current_viewers, title, category FROM streams
            WHERE platform = ? AND channel_id = ? AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`,
      args: [c.platform, c.channel_id],
    });
  }
  const res = await readBatch(db, stmts);
  const cats = new Map();
  const lives = new Map();
  rows.forEach((c, i) => {
    const key = `${c.platform}:${c.channel_id}`;
    cats.set(key, res[i * 2][0]?.category ?? null);
    if (res[i * 2 + 1][0]) lives.set(key, res[i * 2 + 1][0]);
  });
  return { cats, lives };
}

/** 스트리머 랭킹 (기간·플랫폼·카테고리·정렬 기준) + 직전 동일 기간 대비 순위 변동 */
export async function rankings(db, q) {
  const { from, to } = resolveRange(q);
  const sortKey = SORTS[q.sort] ? q.sort : 'watch';
  const sortCol = SORTS[sortKey];
  const limit = clampInt(q.limit, 50, 1, 500);
  const offset = clampInt(q.offset, 0, 0, 100000);
  const search = (q.q || '').trim();

  const agg = rankingAggregate(q, from, to);
  const order = sortCol === 'followers' ? 'COALESCE(c.followers, 0)' : `agg.${sortCol}`;
  const searchSql = search ? 'WHERE (name LIKE ? OR login LIKE ? OR channel_id = ?)' : '';
  const searchArgs = search ? [`%${search}%`, `%${search}%`, search] : [];
  const rows = await all(db, `
    WITH agg AS (${agg.sql}),
    ranked AS (
      SELECT agg.*, c.name, c.login, c.image_url, c.followers,
        ROW_NUMBER() OVER (ORDER BY ${order} DESC, agg.viewer_sec DESC) rank
      FROM agg LEFT JOIN channels c ON c.platform = agg.platform AND c.channel_id = agg.channel_id
    )
    SELECT *, COUNT(*) OVER () total FROM ranked ${searchSql} ORDER BY rank LIMIT ? OFFSET ?`,
  [...agg.args, ...searchArgs, limit, offset]);
  const total = rows[0]?.total ?? 0;

  // 직전 동일 길이 기간 순위
  const span = daysBetween(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  const prevRanks = new Map();
  if (rows.length) {
    const prevAgg = rankingAggregate(q, prevFrom, prevTo);
    const prevCol = sortCol === 'followers' ? 'viewer_sec' : sortCol;
    const prev = await all(db, `
      WITH agg AS (${prevAgg.sql})
      SELECT platform, channel_id, ROW_NUMBER() OVER (ORDER BY ${prevCol} DESC, viewer_sec DESC) rank FROM agg`, prevAgg.args);
    for (const p of prev) prevRanks.set(`${p.platform}:${p.channel_id}`, p.rank);
  }

  const { cats, lives } = await enrichChannels(db, rows, from, to);
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

const LIVE_COLUMNS = `s.id, s.platform, s.channel_id, s.title, s.category, s.thumbnail, s.adult, s.started_at, s.current_viewers, s.peak_viewers,
  c.name, c.image_url, c.followers`;

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

/** 지금 방송 중인 목록 */
export async function liveNow(db, q, cfg) {
  const limit = clampInt(q.limit, 60, 1, 500);
  const offset = clampInt(q.offset, 0, 0, 100000);
  const fresh = nowSec() - cfg.intervalSec * 3;
  const where = ['s.ended_at IS NULL', 's.last_seen_at >= ?'];
  const args = [fresh];
  if (hasPlatform(q.platform)) {
    where.push('s.platform = ?');
    args.push(q.platform);
  }
  const catArgs = [...args];
  if (q.category) {
    where.push('s.category = ?');
    args.push(q.category);
  }
  if (q.q) {
    where.push('(c.name LIKE ? OR s.title LIKE ? OR c.login LIKE ?)');
    args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const from = `FROM streams s LEFT JOIN channels c ON c.platform = s.platform AND c.channel_id = s.channel_id WHERE ${where.join(' AND ')}`;
  const [rows, [total], categories] = await readBatch(db, [
    { sql: `SELECT ${LIVE_COLUMNS} ${from} ORDER BY s.current_viewers DESC LIMIT ? OFFSET ?`, args: [...args, limit, offset] },
    { sql: `SELECT COUNT(*) n, COALESCE(SUM(s.current_viewers), 0) v ${from}`, args },
    {
      sql: `SELECT s.category, COUNT(*) channels, SUM(s.current_viewers) viewers FROM streams s
            WHERE s.ended_at IS NULL AND s.last_seen_at >= ? ${hasPlatform(q.platform) ? 'AND s.platform = ?' : ''}
            GROUP BY s.category ORDER BY viewers DESC LIMIT 30`,
      args: catArgs,
    },
  ]);
  return { total: total.n, totalViewers: total.v, categories, items: rows.map(mapLiveRow) };
}

/** 홈 화면: 플랫폼별 현재 시청자, 24시간 추이, 인기 방송, 인기 카테고리 */
export async function overview(db, cfg) {
  const now = nowSec();
  const fresh = now - cfg.intervalSec * 3;
  const today = kstDate(now);
  const todaySrc = dailyRows({ from: today, to: today });
  const [platforms, trend, top, categories, [todayStats], [meta]] = await readBatch(db, [
    {
      sql: `SELECT p.platform, p.ts, p.viewers, p.channels FROM platform_snapshots p
            JOIN (SELECT platform, MAX(ts) ts FROM platform_snapshots WHERE ts >= ? GROUP BY platform) l
              ON l.platform = p.platform AND l.ts = p.ts`,
      args: [fresh],
    },
    { sql: 'SELECT platform, ts, viewers, channels FROM platform_snapshots WHERE ts >= ? ORDER BY ts', args: [now - 86400 - cfg.intervalSec * 3] },
    {
      sql: `SELECT ${LIVE_COLUMNS} FROM streams s LEFT JOIN channels c ON c.platform = s.platform AND c.channel_id = s.channel_id
            WHERE s.ended_at IS NULL AND s.last_seen_at >= ? ORDER BY s.current_viewers DESC LIMIT 12`,
      args: [fresh],
    },
    {
      sql: `SELECT category, COUNT(*) channels, SUM(current_viewers) viewers FROM streams
            WHERE ended_at IS NULL AND last_seen_at >= ? GROUP BY category ORDER BY viewers DESC LIMIT 10`,
      args: [fresh],
    },
    {
      sql: `SELECT COUNT(DISTINCT platform || ':' || channel_id) channels, COALESCE(SUM(viewer_sec), 0) viewer_sec FROM ${todaySrc.sql}`,
      args: todaySrc.args,
    },
    { sql: 'SELECT (SELECT MAX(rowid) FROM channels) channels, (SELECT MIN(date) FROM daily) since', args: [] },
  ]);

  // 24시간 전 같은 시각 대비 변화 (이미 읽은 추이 데이터에서 계산)
  for (const p of platforms) {
    const t = p.ts - 86400;
    let best = null;
    for (const r of trend) {
      if (r.platform !== p.platform || Math.abs(r.ts - t) > cfg.intervalSec * 2) continue;
      if (!best || Math.abs(r.ts - t) < Math.abs(best.ts - t)) best = r;
    }
    p.viewersDayAgo = best?.viewers ?? null;
  }

  return {
    now,
    platforms,
    trend: trend.filter((r) => r.ts >= now - 86400 - cfg.intervalSec),
    top: top.map(mapLiveRow),
    categories,
    today: { date: today, channels: todayStats.channels, watchHours: todayStats.viewer_sec / 3600 },
    trackedChannels: meta.channels ?? 0,
    since: meta.since,
  };
}

/** 카테고리 랭킹 */
export async function categories(db, q) {
  const { from, to } = resolveRange(q);
  const limit = clampInt(q.limit, 100, 1, 1000);
  const search = (q.q || '').trim();
  const src = dailyRows({ from, to, platform: q.platform });
  const rows = await all(db, `
    SELECT category, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, MAX(peak) peak,
      COUNT(DISTINCT platform || ':' || channel_id) channels,
      SUM(CASE WHEN platform = 'chzzk' THEN viewer_sec ELSE 0 END) chzzk_sec,
      SUM(CASE WHEN platform = 'soop' THEN viewer_sec ELSE 0 END) soop_sec,
      SUM(CASE WHEN platform = 'twitch' THEN viewer_sec ELSE 0 END) twitch_sec,
      SUM(CASE WHEN platform = 'youtube' THEN viewer_sec ELSE 0 END) youtube_sec
    FROM ${src.sql} ${search ? 'WHERE category LIKE ?' : ''}
    GROUP BY category ORDER BY viewer_sec DESC LIMIT ?`, [...src.args, ...(search ? [`%${search}%`] : []), limit]);
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
      byPlatform: { chzzk: r.chzzk_sec / 3600, soop: r.soop_sec / 3600, twitch: r.twitch_sec / 3600, youtube: r.youtube_sec / 3600 },
    })),
  };
}

/** 카테고리 상세 */
export async function categoryDetail(db, name, q) {
  const { from, to } = resolveRange(q);
  const src = dailyRows({ from, to, category: name });
  const [daily, [cnt]] = await readBatch(db, [
    {
      sql: `SELECT date, platform, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, COUNT(DISTINCT channel_id) channels
            FROM ${src.sql} GROUP BY date, platform ORDER BY date`,
      args: src.args,
    },
    { sql: `SELECT COUNT(DISTINCT platform || ':' || channel_id) n FROM ${src.sql}`, args: src.args },
  ]);
  const top = await rankings(db, { ...q, from, to, category: name, limit: q.limit || 30 });
  return {
    category: name, from, to, channels: cnt.n,
    daily: daily.map((d) => ({ date: d.date, platform: d.platform, watchHours: d.viewer_sec / 3600, airHours: d.air_sec / 3600, channels: d.channels })),
    top: top.items,
  };
}

/** 플랫폼 비교: 일자별 시청 시간 · 동시 시청자 */
export async function platformsStats(db, q) {
  const { from, to } = resolveRange(q);
  const src = dailyRows({ from, to });
  const tsFrom = kstDayStart(from);
  const tsTo = kstDayStart(addDays(to, 1)) - 1;
  const [daily, concurrent, channels, hourly] = await readBatch(db, [
    {
      sql: `SELECT date, platform, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, COUNT(DISTINCT channel_id) channels
            FROM ${src.sql} GROUP BY date, platform ORDER BY date`,
      args: src.args,
    },
    {
      sql: `SELECT date(ts + ${KST_OFFSET}, 'unixepoch') date, platform, CAST(AVG(viewers) AS INTEGER) avg, MAX(viewers) peak
            FROM platform_snapshots WHERE ts BETWEEN ? AND ? GROUP BY date, platform ORDER BY date`,
      args: [tsFrom, tsTo],
    },
    { sql: `SELECT platform, COUNT(DISTINCT channel_id) channels FROM ${src.sql} GROUP BY platform`, args: src.args },
    {
      // 시간대별 평균 동시 시청자 (KST)
      sql: `SELECT CAST(strftime('%H', ts + ${KST_OFFSET}, 'unixepoch') AS INTEGER) hour, platform, CAST(AVG(viewers) AS INTEGER) viewers
            FROM platform_snapshots WHERE ts BETWEEN ? AND ? GROUP BY hour, platform ORDER BY hour`,
      args: [tsFrom, tsTo],
    },
  ]);
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
  for (const c of channels) if (totals[c.platform]) totals[c.platform].channels = c.channels;

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

export async function searchChannels(db, q) {
  const s = (q.q || '').trim();
  if (!s) return { items: [] };
  const limit = clampInt(q.limit, 10, 1, 50);
  const rows = await all(db, `
    SELECT c.platform, c.channel_id, c.name, c.login, c.image_url, c.followers, c.last_live_at,
      (SELECT current_viewers FROM streams s WHERE s.platform = c.platform AND s.channel_id = c.channel_id AND s.ended_at IS NULL LIMIT 1) live_viewers
    FROM channels c
    WHERE c.name LIKE ? OR c.login LIKE ? OR c.channel_id = ?
    ORDER BY (c.name = ?) DESC, (live_viewers IS NOT NULL) DESC, COALESCE(c.followers, 0) DESC, c.last_live_at DESC
    LIMIT ?`, [`%${s}%`, `%${s}%`, s, s, limit]);
  return {
    items: rows.map((r) => ({
      platform: r.platform, channelId: r.channel_id, name: r.name, login: r.login, image: r.image_url,
      followers: r.followers, lastLiveAt: r.last_live_at, liveViewers: r.live_viewers,
    })),
  };
}

/** timeline 의 각 점이 대표하는 시간(초): 직전 점과의 간격, 최대 2주기 */
function withDurations(points, intervalSec) {
  return points.map((p, i) => ({ ...p, dur: i === 0 ? intervalSec : Math.min(p.ts - points[i - 1].ts, intervalSec * 2) }));
}

/** 스트리머 상세 */
export async function channelDetail(db, platform, channelId, q, cfg = { intervalSec: 300 }) {
  const { from, to } = resolveRange(q);
  const tsFrom = kstDayStart(from);
  const tsTo = kstDayStart(addDays(to, 1)) - 1;
  const src = dailyRows({ from, to, platform, channelId });
  const [[ch], [summary], [streamsCount], daily, cats, followers, streams, [live]] = await readBatch(db, [
    { sql: 'SELECT * FROM channels WHERE platform = ? AND channel_id = ?', args: [platform, channelId] },
    {
      sql: `SELECT COALESCE(SUM(viewer_sec), 0) viewer_sec, COALESCE(SUM(air_sec), 0) air_sec, COALESCE(MAX(peak), 0) peak, COUNT(DISTINCT date) days
            FROM ${src.sql}`,
      args: src.args,
    },
    { sql: 'SELECT COUNT(*) n FROM streams WHERE platform = ? AND channel_id = ? AND started_at BETWEEN ? AND ?', args: [platform, channelId, tsFrom, tsTo] },
    {
      sql: `SELECT date, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, MAX(peak) peak FROM ${src.sql} GROUP BY date ORDER BY date`,
      args: src.args,
    },
    {
      sql: `SELECT category, SUM(viewer_sec) viewer_sec, SUM(air_sec) air_sec, MAX(peak) peak FROM ${src.sql}
            GROUP BY category ORDER BY air_sec DESC`,
      args: src.args,
    },
    {
      sql: 'SELECT date, followers FROM follower_history WHERE platform = ? AND channel_id = ? AND date BETWEEN ? AND ? ORDER BY date',
      args: [platform, channelId, addDays(from, -1), to],
    },
    {
      // 기간과 겹치는 방송 (히트맵용 timeline 포함)
      sql: `SELECT id, title, category, thumbnail, started_at, ended_at, last_seen_at, current_viewers, peak_viewers, viewer_sec, air_sec, timeline
            FROM streams WHERE platform = ? AND channel_id = ? AND started_at <= ? AND last_seen_at >= ?
            ORDER BY started_at DESC LIMIT 200`,
      args: [platform, channelId, tsTo, tsFrom],
    },
    {
      sql: `SELECT id, title, category, thumbnail, started_at, current_viewers, peak_viewers FROM streams
            WHERE platform = ? AND channel_id = ? AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`,
      args: [platform, channelId],
    },
  ]);
  if (!ch) return null;

  // 플랫폼 내 순위 (시청 시간 기준)
  const pSrc = dailyRows({ from, to, platform });
  const rank = await get(db, `
    WITH agg AS (SELECT channel_id, SUM(viewer_sec) vs FROM ${pSrc.sql} GROUP BY channel_id)
    SELECT (SELECT COUNT(*) FROM agg WHERE vs > a.vs) + 1 rank, (SELECT COUNT(*) FROM agg) total FROM agg a WHERE channel_id = ?`,
  [...pSrc.args, channelId]);

  // 요일 × 시간대 방송 패턴 (KST) — 방송별 timeline 으로 계산
  const heat = new Map();
  for (const st of streams) {
    for (const p of withDurations(parseTimeline(st.timeline), cfg.intervalSec)) {
      if (p.ts < tsFrom || p.ts > tsTo) continue;
      const d = new Date((p.ts + KST_OFFSET) * 1000);
      const key = `${d.getUTCDay()}:${d.getUTCHours()}`;
      const h = heat.get(key) ?? { dow: d.getUTCDay(), hour: d.getUTCHours(), air: 0, vs: 0 };
      h.air += p.dur;
      h.vs += p.viewers * p.dur;
      heat.set(key, h);
    }
  }

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
      streams: streamsCount.n,
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
    heatmap: [...heat.values()].map((h) => ({ dow: h.dow, hour: h.hour, airHours: h.air / 3600, avgViewers: h.air ? Math.round(h.vs / h.air) : 0 })),
    followers,
    streams: streams.filter((st) => st.started_at >= tsFrom).map(mapStream),
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
export async function streamDetail(db, id) {
  const s = await get(db, 'SELECT * FROM streams WHERE id = ?', [id]);
  if (!s) return null;
  const since = s.started_at - 30 * 86400;
  const [[ch], [prevNext], [channelAvg]] = await readBatch(db, [
    { sql: 'SELECT * FROM channels WHERE platform = ? AND channel_id = ?', args: [s.platform, s.channel_id] },
    {
      sql: `SELECT
              (SELECT id FROM streams WHERE platform = ? AND channel_id = ? AND started_at < ? ORDER BY started_at DESC LIMIT 1) prev,
              (SELECT id FROM streams WHERE platform = ? AND channel_id = ? AND started_at > ? ORDER BY started_at ASC LIMIT 1) next`,
      args: [s.platform, s.channel_id, s.started_at, s.platform, s.channel_id, s.started_at],
    },
    {
      // 채널 평균 대비 (최근 30일)
      sql: 'SELECT SUM(viewer_sec) vs, SUM(air_sec) a FROM streams WHERE platform = ? AND channel_id = ? AND started_at BETWEEN ? AND ? AND id != ?',
      args: [s.platform, s.channel_id, since, s.started_at, id],
    },
  ]);

  const points = parseTimeline(s.timeline);
  let segs = [];
  try {
    segs = JSON.parse(s.segments || '[]');
  } catch {
    // 무시
  }
  // [[시작 ts, 카테고리], ...] → 각 점에 카테고리 표시, 구간별 시작/끝
  const timeline = points.map((p) => {
    let cat = segs[0]?.[1] ?? s.category;
    for (const [t, c] of segs) if (t <= p.ts) cat = c;
    return { ts: p.ts, viewers: p.viewers, category: cat };
  });
  const segments = [];
  for (const t of timeline) {
    const last = segments.at(-1);
    if (last && last.category === t.category) last.to = t.ts;
    else segments.push({ category: t.category, from: t.ts, to: t.ts });
  }

  return {
    stream: { ...mapStream(s), platform: s.platform, channelId: s.channel_id, streamKey: s.stream_key, currentViewers: s.current_viewers, adult: !!s.adult },
    channel: ch ? { platform: ch.platform, channelId: ch.channel_id, name: ch.name, login: ch.login, image: ch.image_url, followers: ch.followers } : null,
    timeline,
    segments,
    prevId: prevNext.prev,
    nextId: prevNext.next,
    channelAvgViewers: channelAvg?.a ? Math.round(channelAvg.vs / channelAvg.a) : null,
  };
}

/** 여러 스트리머 비교 */
export async function compare(db, ids, q, cfg) {
  const { from, to } = resolveRange(q);
  const details = await Promise.all(ids.slice(0, 6).map((raw) => {
    const [platform, ...rest] = raw.split(':');
    return channelDetail(db, platform, rest.join(':'), { from, to }, cfg);
  }));
  return {
    from, to,
    items: details.filter(Boolean).map((d) => ({
      channel: d.channel, live: d.live, summary: d.summary, daily: d.daily, categories: d.categories.slice(0, 5), heatmap: d.heatmap,
    })),
  };
}

/** 즐겨찾기 등 여러 채널의 현재 상태 + 기간 요약 (최대 100개) */
export async function channelsBatch(db, ids, q) {
  const { from, to } = resolveRange(q);
  const keys = ids.slice(0, 100).map((raw) => {
    const [platform, ...rest] = raw.split(':');
    return { platform, channelId: rest.join(':') };
  });
  const stmts = [];
  for (const k of keys) {
    const src = dailyRows({ from, to, platform: k.platform, channelId: k.channelId });
    stmts.push(
      { sql: 'SELECT * FROM channels WHERE platform = ? AND channel_id = ?', args: [k.platform, k.channelId] },
      { sql: `SELECT COALESCE(SUM(viewer_sec), 0) vs, COALESCE(SUM(air_sec), 0) a, COALESCE(MAX(peak), 0) peak FROM ${src.sql}`, args: src.args },
      {
        sql: `SELECT id, title, category, current_viewers, started_at FROM streams
              WHERE platform = ? AND channel_id = ? AND ended_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`,
        args: [k.platform, k.channelId],
      },
    );
  }
  const res = await readBatch(db, stmts);
  const items = [];
  keys.forEach((k, i) => {
    const [ch] = res[i * 3];
    if (!ch) return;
    const [sm] = res[i * 3 + 1];
    const [live] = res[i * 3 + 2];
    items.push({
      platform: k.platform, channelId: k.channelId, name: ch.name, login: ch.login, image: ch.image_url, followers: ch.followers, lastLiveAt: ch.last_live_at,
      live: live ? { streamId: live.id, title: live.title, category: live.category, viewers: live.current_viewers, startedAt: live.started_at } : null,
      avgViewers: sm.a ? Math.round(sm.vs / sm.a) : 0, peakViewers: sm.peak, airHours: sm.a / 3600, watchHours: sm.vs / 3600,
    });
  });
  return { from, to, items };
}

export async function status(db, cfg) {
  const [rows, [counts]] = await readBatch(db, [
    { sql: 'SELECT * FROM collector_status', args: [] },
    // COUNT(*) 대신 최대 rowid 를 사용 (행을 전부 읽지 않도록)
    { sql: 'SELECT (SELECT MAX(rowid) FROM channels) channels, (SELECT MAX(id) FROM streams) streams, (SELECT MIN(date) FROM daily) since', args: [] },
  ]);
  const liveTotal = rows.reduce((a, r) => a + (r.last_error ? 0 : r.live_count || 0), 0);
  return {
    demo: cfg.demo,
    intervalSec: cfg.intervalSec,
    minViewers: cfg.minViewers,
    collectorEnabled: cfg.enableCollector,
    // 방송 1개당 수집 1회에 약 1행을 쓰므로, 지금 방송 수 기준 월간 쓰기량 추정
    estimatedMonthlyWrites: Math.round(liveTotal * (30 * 86400 / cfg.intervalSec)),
    platforms: rows.map((r) => ({
      platform: r.platform, lastRunAt: r.last_run_at, lastSuccessAt: r.last_success_at, lastError: r.last_error,
      liveCount: r.live_count, totalViewers: r.total_viewers, durationMs: r.duration_ms,
    })),
    channels: counts.channels ?? 0,
    streams: counts.streams ?? 0,
    since: counts.since,
  };
}
