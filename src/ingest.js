import { tx } from './db.js';
import { kstDate } from './util.js';

/**
 * 수집기가 반환하는 정규화된 라이브 항목:
 * { channelId, channelName, login?, channelImage?, streamKey, title, category, viewers, startedAt, thumbnail?, adult? }
 */

const NO_CATEGORY = '기타';

/**
 * 한 플랫폼의 라이브 목록 1회분을 저장한다.
 * - 방송(streams) upsert, 스냅샷 기록, 일별(daily) 집계 누적
 * - 이번 수집에 보이지 않은 방송은 일정 시간(grace) 후 종료 처리
 */
export function ingest(db, platform, items, ts, intervalSec) {
  const date = kstDate(ts);
  const maxDur = intervalSec * 2;
  const graceSec = Math.round(intervalSec * 2.5);

  const upsertChannel = db.prepare(`
    INSERT INTO channels (platform, channel_id, name, login, image_url, first_seen_at, last_live_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, channel_id) DO UPDATE SET
      name = excluded.name,
      login = COALESCE(excluded.login, channels.login),
      image_url = COALESCE(excluded.image_url, channels.image_url),
      last_live_at = excluded.last_live_at`);
  const findStream = db.prepare('SELECT id, last_seen_at, ended_at FROM streams WHERE platform = ? AND stream_key = ?');
  const insertStream = db.prepare(`
    INSERT INTO streams (platform, stream_key, channel_id, title, category, thumbnail, adult, started_at, last_seen_at,
      current_viewers, peak_viewers, viewer_sec, air_sec, samples)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const updateStream = db.prepare(`
    UPDATE streams SET title = ?, category = ?, thumbnail = COALESCE(?, thumbnail), adult = ?, last_seen_at = ?, ended_at = NULL,
      current_viewers = ?, peak_viewers = MAX(peak_viewers, ?), viewer_sec = viewer_sec + ?, air_sec = air_sec + ?, samples = samples + 1
    WHERE id = ?`);
  const insertSnap = db.prepare('INSERT INTO snapshots (stream_id, platform, channel_id, ts, viewers, dur, category) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const upsertDaily = db.prepare(`
    INSERT INTO daily (date, platform, channel_id, category, viewer_sec, air_sec, peak) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, platform, channel_id, category) DO UPDATE SET
      viewer_sec = viewer_sec + excluded.viewer_sec,
      air_sec = air_sec + excluded.air_sec,
      peak = MAX(peak, excluded.peak)`);
  const upsertPlatform = db.prepare(`
    INSERT INTO platform_snapshots (platform, ts, viewers, channels) VALUES (?, ?, ?, ?)
    ON CONFLICT(platform, ts) DO UPDATE SET viewers = excluded.viewers, channels = excluded.channels`);
  const closeStale = db.prepare(`
    UPDATE streams SET ended_at = last_seen_at, current_viewers = 0
    WHERE platform = ? AND ended_at IS NULL AND last_seen_at < ?`);

  // 같은 방송이 페이지 경계에서 중복으로 내려오는 경우 제거
  const seen = new Map();
  for (const it of items) {
    if (!it || !it.channelId || !it.streamKey) continue;
    const key = String(it.streamKey);
    const prev = seen.get(key);
    if (!prev || prev.viewers < it.viewers) seen.set(key, it);
  }
  const unique = [...seen.values()];

  let totalViewers = 0;
  tx(db, () => {
    for (const it of unique) {
      const viewers = Math.max(0, Math.round(Number(it.viewers) || 0));
      const category = (it.category && String(it.category).trim()) || NO_CATEGORY;
      totalViewers += viewers;

      upsertChannel.run(platform, String(it.channelId), it.channelName ?? null, it.login ?? null, it.channelImage ?? null, ts, ts);

      const row = findStream.get(platform, String(it.streamKey));
      let streamId;
      let dur;
      if (!row) {
        dur = intervalSec;
        const startedAt = it.startedAt && it.startedAt <= ts ? it.startedAt : ts;
        const r = insertStream.run(platform, String(it.streamKey), String(it.channelId), it.title ?? '', category, it.thumbnail ?? null,
          it.adult ? 1 : 0, startedAt, ts, viewers, viewers, viewers * dur, dur);
        streamId = Number(r.lastInsertRowid);
      } else {
        if (row.last_seen_at >= ts) continue; // 같은 시각 재수집 방지
        dur = Math.min(ts - row.last_seen_at, maxDur);
        streamId = row.id;
        updateStream.run(it.title ?? '', category, it.thumbnail ?? null, it.adult ? 1 : 0, ts, viewers, viewers, viewers * dur, dur, streamId);
      }
      insertSnap.run(streamId, platform, String(it.channelId), ts, viewers, dur, category);
      upsertDaily.run(date, platform, String(it.channelId), category, viewers * dur, dur, viewers);
    }
    upsertPlatform.run(platform, ts, totalViewers, unique.length);
    closeStale.run(platform, ts - graceSec);
  });

  return { liveCount: unique.length, totalViewers };
}

export function recordStatus(db, platform, { ts, ok, error, liveCount, totalViewers, durationMs }) {
  db.prepare(`
    INSERT INTO collector_status (platform, last_run_at, last_success_at, last_error, live_count, total_viewers, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      last_success_at = COALESCE(excluded.last_success_at, collector_status.last_success_at),
      last_error = excluded.last_error,
      live_count = COALESCE(excluded.live_count, collector_status.live_count),
      total_viewers = COALESCE(excluded.total_viewers, collector_status.total_viewers),
      duration_ms = excluded.duration_ms`)
    .run(platform, ts, ok ? ts : null, error ?? null, liveCount ?? null, totalViewers ?? null, durationMs ?? null);
}

export function recordFollowers(db, platform, channelId, followers, ts) {
  if (followers === null || followers === undefined || !Number.isFinite(Number(followers))) return;
  const n = Math.round(Number(followers));
  db.prepare('UPDATE channels SET followers = ?, followers_updated_at = ? WHERE platform = ? AND channel_id = ?').run(n, ts, platform, channelId);
  db.prepare(`
    INSERT INTO follower_history (platform, channel_id, date, followers) VALUES (?, ?, ?, ?)
    ON CONFLICT(platform, channel_id, date) DO UPDATE SET followers = excluded.followers`).run(platform, channelId, kstDate(ts), n);
}

/** 오래된 스냅샷 정리 (일별 집계는 유지) */
export function pruneOld(db, retentionDays, now) {
  const cutoff = now - retentionDays * 86400;
  db.prepare('DELETE FROM snapshots WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM platform_snapshots WHERE ts < ?').run(now - Math.max(retentionDays, 400) * 86400);
}
