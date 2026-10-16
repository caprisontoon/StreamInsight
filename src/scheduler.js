import { createCollectors } from './collectors/index.js';
import { ingest, pruneOld, recordFollowers, recordStatus } from './ingest.js';
import { kstDate, nowSec, sleep } from './util.js';

/**
 * 주기적으로 각 플랫폼의 라이브 목록을 수집한다.
 * 수집 시각은 주기 경계(예: 5분 단위)에 맞춰 정렬되어 플랫폼 간 비교가 쉽다.
 */
export function createScheduler(db, cfg, log = console) {
  const collectors = createCollectors(cfg, { db });
  let timer = null;
  let followerRunning = false;
  let lastPruneDate = null;

  async function collectPlatform(c, ts) {
    const started = Date.now();
    if (!c.enabled) {
      recordStatus(db, c.id, { ts, ok: false, error: c.disabledReason, durationMs: 0 });
      return;
    }
    try {
      const lives = await c.fetchLives();
      const r = ingest(db, c.id, lives, ts, cfg.intervalSec);
      recordStatus(db, c.id, { ts, ok: true, liveCount: r.liveCount, totalViewers: r.totalViewers, durationMs: Date.now() - started });
      log.info?.(`[collect] ${c.id}: 방송 ${r.liveCount}개, 시청자 ${r.totalViewers.toLocaleString()}명 (${Date.now() - started}ms)`);
    } catch (err) {
      recordStatus(db, c.id, { ts, ok: false, error: String(err.message || err), durationMs: Date.now() - started });
      log.error?.(`[collect] ${c.id} 실패: ${err.message || err}`);
    }
  }

  /** 오늘 팔로워 수가 갱신되지 않은 상위 채널을 천천히 갱신 */
  async function updateFollowers() {
    if (followerRunning || cfg.followerTopN <= 0) return;
    followerRunning = true;
    try {
      const today = kstDate(nowSec());
      for (const c of collectors.filter((x) => x.enabled && x.fetchFollowers)) {
        const rows = db.prepare(`
          SELECT s.channel_id FROM streams s
          LEFT JOIN follower_history f ON f.platform = s.platform AND f.channel_id = s.channel_id AND f.date = ?
          WHERE s.platform = ? AND s.ended_at IS NULL AND f.channel_id IS NULL
          ORDER BY s.current_viewers DESC LIMIT ?`).all(today, c.id, cfg.followerTopN);
        for (const { channel_id } of rows) {
          try {
            const n = await c.fetchFollowers(channel_id);
            recordFollowers(db, c.id, channel_id, n, nowSec());
          } catch {
            // 개별 채널 실패는 무시
          }
          await sleep(300);
        }
      }
    } finally {
      followerRunning = false;
    }
  }

  async function runOnce(ts = Math.floor(nowSec() / cfg.intervalSec) * cfg.intervalSec) {
    await Promise.all(collectors.map((c) => collectPlatform(c, ts)));
    const today = kstDate(ts);
    if (lastPruneDate !== today) {
      lastPruneDate = today;
      pruneOld(db, cfg.snapshotRetentionDays, ts);
    }
  }

  function scheduleNext() {
    const now = Date.now();
    const period = cfg.intervalSec * 1000;
    const wait = period - (now % period) + 2000; // 경계 2초 뒤
    timer = setTimeout(async () => {
      try {
        await runOnce();
        updateFollowers().catch(() => {});
      } finally {
        scheduleNext();
      }
    }, wait);
  }

  return {
    collectors,
    runOnce,
    updateFollowers,
    start() {
      log.info?.(`[collect] 수집 시작: ${collectors.map((c) => c.id + (c.enabled ? '' : '(비활성)')).join(', ')} / ${cfg.intervalSec}초 주기`);
      runOnce().then(() => updateFollowers().catch(() => {}));
      scheduleNext();
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
