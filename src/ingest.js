import { all, batch, run } from './db.js';
import { kstDate } from './util.js';

/**
 * 수집기가 반환하는 정규화된 라이브 항목:
 * { channelId, channelName, login?, channelImage?, streamKey, title, category, viewers, startedAt, thumbnail?, adult? }
 */

const NO_CATEGORY = '기타';
const s = (sql, args) => ({ sql, args });

/** day_stats 키: 'YYYY-MM-DD|카테고리' → [viewer_sec, air_sec, peak] */
export const dayKey = (date, category) => `${date}|${category}`;

/**
 * 한 플랫폼의 라이브 목록 1회분을 저장한다.
 *  - 방송 중인 방송: streams 행 1개만 갱신 (timeline 에 시청자 이어 붙이기, day_stats 누적)
 *  - 새 방송: streams 삽입 + channels upsert
 *  - 일정 시간(grace) 보이지 않은 방송: 종료 처리하고 day_stats 를 daily 로 옮김
 */
export async function ingest(db, platform, items, ts, intervalSec) {
  const date = kstDate(ts);
  const maxDur = intervalSec * 2;
  const graceSec = Math.round(intervalSec * 2.5);

  // 같은 방송이 페이지 경계에서 중복으로 내려오는 경우 제거
  const seen = new Map();
  for (const it of items) {
    if (!it || !it.channelId || !it.streamKey) continue;
    const key = String(it.streamKey);
    const prev = seen.get(key);
    if (!prev || prev.viewers < it.viewers) seen.set(key, it);
  }
  const unique = [...seen.values()];

  // 방송 중이거나 최근 1시간 안에 끝난 방송 (다시 나타나면 이어서 기록)
  const rows = await all(db, `
    SELECT id, stream_key, channel_id, last_seen_at, ended_at, category, day_stats FROM streams
    WHERE platform = ? AND (ended_at IS NULL OR last_seen_at >= ?)`, [platform, ts - 3600]);
  const byKey = new Map(rows.map((r) => [String(r.stream_key), r]));

  const stmts = [];
  let totalViewers = 0;
  for (const it of unique) {
    const viewers = Math.max(0, Math.round(Number(it.viewers) || 0));
    const category = (it.category && String(it.category).trim()) || NO_CATEGORY;
    const channelId = String(it.channelId);
    const streamKey = String(it.streamKey);
    totalViewers += viewers;
    const row = byKey.get(streamKey);

    if (!row) {
      const dur = intervalSec;
      const startedAt = it.startedAt && it.startedAt <= ts ? it.startedAt : ts;
      const dayStats = { [dayKey(date, category)]: [viewers * dur, dur, viewers] };
      stmts.push(s(`
        INSERT INTO channels (platform, channel_id, name, login, image_url, first_seen_at, last_live_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, channel_id) DO UPDATE SET
          name = excluded.name,
          login = COALESCE(excluded.login, channels.login),
          image_url = COALESCE(excluded.image_url, channels.image_url),
          last_live_at = excluded.last_live_at`,
      [platform, channelId, it.channelName ?? null, it.login ?? null, it.channelImage ?? null, ts, ts]));
      stmts.push(s(`
        INSERT INTO streams (platform, stream_key, channel_id, title, category, thumbnail, adult, started_at, last_seen_at,
          current_viewers, peak_viewers, viewer_sec, air_sec, samples, timeline, segments, day_stats)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, json_array(json_array(?, ?)), ?)
        ON CONFLICT(platform, stream_key) DO NOTHING`,
      [platform, streamKey, channelId, it.title ?? '', category, it.thumbnail ?? null, it.adult ? 1 : 0, startedAt, ts,
        viewers, viewers, viewers * dur, dur, `${ts},${viewers};`, ts, category, JSON.stringify(dayStats)]));
      continue;
    }

    if (row.last_seen_at >= ts) continue; // 같은 시각 재수집 방지
    const dur = Math.min(ts - row.last_seen_at, maxDur);
    let dayStats;
    try {
      dayStats = JSON.parse(row.day_stats || '{}');
    } catch {
      dayStats = {};
    }
    const k = dayKey(date, category);
    const d = (dayStats[k] ??= [0, 0, 0]);
    d[0] += viewers * dur;
    d[1] += dur;
    d[2] = Math.max(d[2], viewers);
    const changed = row.category !== category ? 1 : 0;
    stmts.push(s(`
      UPDATE streams SET title = ?, category = ?, thumbnail = COALESCE(?, thumbnail), adult = ?, last_seen_at = ?, ended_at = NULL,
        current_viewers = ?, peak_viewers = MAX(peak_viewers, ?), viewer_sec = viewer_sec + ?, air_sec = air_sec + ?, samples = samples + 1,
        timeline = COALESCE(timeline, '') || ?,
        segments = CASE WHEN ? THEN json_insert(COALESCE(segments, '[]'), '$[#]', json_array(?, ?)) ELSE segments END,
        day_stats = ?
      WHERE id = ?`,
    [it.title ?? '', category, it.thumbnail ?? null, it.adult ? 1 : 0, ts, viewers, viewers, viewers * dur, dur,
      `${ts},${viewers};`, changed, ts, category, JSON.stringify(dayStats), row.id]));
    if (row.ended_at !== null) {
      // 종료 처리됐다가 다시 나타난 방송
      stmts.push(s('UPDATE channels SET last_live_at = ? WHERE platform = ? AND channel_id = ?', [ts, platform, channelId]));
    }
  }

  // 종료 처리: 이번 수집에 없고 grace 이상 보이지 않은 방송
  for (const r of rows) {
    if (r.ended_at !== null || seen.has(String(r.stream_key)) || r.last_seen_at >= ts - graceSec) continue;
    stmts.push(...closeStatements(platform, r));
  }

  stmts.push(s(`
    INSERT INTO platform_snapshots (platform, ts, viewers, channels) VALUES (?, ?, ?, ?)
    ON CONFLICT(platform, ts) DO UPDATE SET viewers = excluded.viewers, channels = excluded.channels`,
  [platform, ts, totalViewers, unique.length]));

  await batch(db, stmts);
  return { liveCount: unique.length, totalViewers };
}

/** 방송 종료: day_stats 를 daily 로 옮기고 비운다 */
function closeStatements(platform, r) {
  const out = [];
  let dayStats = {};
  try {
    dayStats = JSON.parse(r.day_stats || '{}');
  } catch {
    // 무시
  }
  for (const [key, [vs, as, peak]] of Object.entries(dayStats)) {
    const i = key.indexOf('|');
    out.push(s(`
      INSERT INTO daily (date, platform, channel_id, category, viewer_sec, air_sec, peak) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, platform, channel_id, category) DO UPDATE SET
        viewer_sec = viewer_sec + excluded.viewer_sec, air_sec = air_sec + excluded.air_sec, peak = MAX(peak, excluded.peak)`,
    [key.slice(0, i), platform, r.channel_id, key.slice(i + 1), vs, as, peak]));
  }
  out.push(s("UPDATE streams SET ended_at = last_seen_at, current_viewers = 0, day_stats = '{}' WHERE id = ?", [r.id]));
  out.push(s('UPDATE channels SET last_live_at = MAX(COALESCE(last_live_at, 0), ?) WHERE platform = ? AND channel_id = ?', [r.last_seen_at, platform, r.channel_id]));
  return out;
}

export async function recordStatus(db, platform, { ts, ok, error, liveCount, totalViewers, durationMs }) {
  await run(db, `
    INSERT INTO collector_status (platform, last_run_at, last_success_at, last_error, live_count, total_viewers, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      last_success_at = COALESCE(excluded.last_success_at, collector_status.last_success_at),
      last_error = excluded.last_error,
      live_count = COALESCE(excluded.live_count, collector_status.live_count),
      total_viewers = COALESCE(excluded.total_viewers, collector_status.total_viewers),
      duration_ms = excluded.duration_ms`,
  [platform, ts, ok ? ts : null, error ?? null, liveCount ?? null, totalViewers ?? null, durationMs ?? null]);
}

export async function recordFollowers(db, platform, channelId, followers, ts) {
  if (followers === null || followers === undefined || !Number.isFinite(Number(followers))) return;
  const n = Math.round(Number(followers));
  await db.batch([
    s('UPDATE channels SET followers = ?, followers_updated_at = ? WHERE platform = ? AND channel_id = ?', [n, ts, platform, channelId]),
    s(`INSERT INTO follower_history (platform, channel_id, date, followers) VALUES (?, ?, ?, ?)
       ON CONFLICT(platform, channel_id, date) DO UPDATE SET followers = excluded.followers`, [platform, channelId, kstDate(ts), n]),
  ], 'write');
}

/** 오래된 방송의 상세 기록(timeline) 정리. 방송 요약과 일별 집계는 유지 */
export async function pruneOld(db, retentionDays, now) {
  await db.batch([
    s('UPDATE streams SET timeline = NULL, segments = NULL WHERE started_at < ? AND timeline IS NOT NULL', [now - retentionDays * 86400]),
    s('DELETE FROM platform_snapshots WHERE ts < ?', [now - Math.max(retentionDays, 400) * 86400]),
  ], 'write');
}

/** timeline 문자열 'ts,viewers;ts,viewers;' → [{ ts, viewers }] */
export function parseTimeline(text) {
  if (!text) return [];
  const out = [];
  for (const part of text.split(';')) {
    if (!part) continue;
    const [t, v] = part.split(',');
    out.push({ ts: Number(t), viewers: Number(v) });
  }
  return out;
}
