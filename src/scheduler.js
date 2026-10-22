import { createCollectors } from './collectors/index.js';
import { all, kvGet, kvSet } from './db.js';
import { ingest, pruneOld, recordFollowers, recordStatus } from './ingest.js';
import { kstDate, nowSec, sleep } from './util.js';

const STATE_KEY = 'collector_state';

/**
 * 각 플랫폼의 라이브 목록을 수집한다.
 *  - 상시 실행(npm start): start() 가 주기 경계(예: 5분 단위)마다 runOnce() 실행
 *  - 서버리스(Vercel): 외부 스케줄러가 /api/cron/collect 를 호출할 때마다 runOnce() 1회
 * 유튜브 쿼터, 트위치 토큰 같은 수집기 상태는 DB(kv)에 저장해 호출 간에 이어진다.
 */
export function createScheduler(db, cfg, log = console) {
  const state = {};
  let collectors = null;
  let timer = null;
  let followerRunning = false;

  async function init() {
    if (collectors) return collectors;
    Object.assign(state, await kvGet(db, STATE_KEY, {}));
    collectors = createCollectors(cfg, { db, state });
    return collectors;
  }

  async function collectPlatform(c, ts) {
    const started = Date.now();
    if (!c.enabled) {
      await recordStatus(db, c.id, { ts, ok: false, error: c.disabledReason, durationMs: 0 });
      return { platform: c.id, ok: false, error: c.disabledReason };
    }
    try {
      const lives = await c.fetchLives();
      const r = await ingest(db, c.id, lives, ts, cfg.intervalSec);
      const durationMs = Date.now() - started;
      await recordStatus(db, c.id, { ts, ok: true, liveCount: r.liveCount, totalViewers: r.totalViewers, durationMs });
      log.info?.(`[collect] ${c.id}: 방송 ${r.liveCount}개, 시청자 ${r.totalViewers.toLocaleString()}명 (${durationMs}ms)`);
      return { platform: c.id, ok: true, ...r, durationMs };
    } catch (err) {
      const error = String(err.message || err);
      await recordStatus(db, c.id, { ts, ok: false, error, durationMs: Date.now() - started }).catch(() => {});
      log.error?.(`[collect] ${c.id} 실패: ${error}`);
      return { platform: c.id, ok: false, error };
    }
  }

  /** 오늘 팔로워 수가 갱신되지 않은 방송 중 상위 채널을 갱신 (deadline 까지만) */
  async function updateFollowers({ deadline = Infinity, perPlatform = cfg.followerTopN, delayMs = 300 } = {}) {
    if (followerRunning || cfg.followerTopN <= 0) return 0;
    followerRunning = true;
    let updated = 0;
    try {
      await init();
      const today = kstDate(nowSec());
      for (const c of collectors.filter((x) => x.enabled && x.fetchFollowers)) {
        const rows = await all(db, `
          SELECT s.channel_id FROM streams s
          LEFT JOIN follower_history f ON f.platform = s.platform AND f.channel_id = s.channel_id AND f.date = ?
          WHERE s.ended_at IS NULL AND s.platform = ? AND f.channel_id IS NULL
          ORDER BY s.current_viewers DESC LIMIT ?`, [today, c.id, Math.min(perPlatform, cfg.followerTopN)]);
        for (const { channel_id: channelId } of rows) {
          if (Date.now() > deadline) return updated;
          try {
            const n = await c.fetchFollowers(channelId);
            await recordFollowers(db, c.id, channelId, n, nowSec());
            updated += 1;
          } catch {
            // 개별 채널 실패는 무시
          }
          if (delayMs) await sleep(delayMs);
        }
      }
      return updated;
    } finally {
      followerRunning = false;
      await saveState();
    }
  }

  async function saveState() {
    await kvSet(db, STATE_KEY, state).catch(() => {});
  }

  async function runOnce(ts = Math.floor(nowSec() / cfg.intervalSec) * cfg.intervalSec) {
    await init();
    const results = await Promise.all(collectors.map((c) => collectPlatform(c, ts)));
    await saveState();
    const today = kstDate(ts);
    if (state.lastPruneDate !== today) {
      state.lastPruneDate = today;
      await pruneOld(db, cfg.snapshotRetentionDays, ts).catch(() => {});
      await saveState();
    }
    return { ts, results };
  }

  function scheduleNext() {
    const period = cfg.intervalSec * 1000;
    const wait = period - (Date.now() % period) + 2000; // 경계 2초 뒤
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
    init,
    runOnce,
    updateFollowers,
    get collectors() {
      return collectors;
    },
    async start() {
      await init();
      log.info?.(`[collect] 수집 시작: ${collectors.map((c) => c.id + (c.enabled ? '' : '(비활성)')).join(', ')} / ${cfg.intervalSec}초 주기`);
      runOnce().then(() => updateFollowers().catch(() => {}));
      scheduleNext();
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
