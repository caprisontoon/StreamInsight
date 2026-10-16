import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Q from './queries.js';
import { createScheduler } from './scheduler.js';
import { kstDate, nowSec, toCsv } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR = {
  '/vendor/chart.umd.min.js': path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.min.js'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const PLATFORM_LABEL = { chzzk: '치지직', soop: 'SOOP', twitch: '트위치', youtube: '유튜브' };
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * CDN 캐시 시간(초). 같은 요청은 캐시에서 응답해 DB 읽기를 줄인다.
 *  - 실시간 화면: 1분 (수집 주기보다 짧게)
 *  - 오늘이 포함된 기간: 5분
 *  - 지난 기간: 1시간 (더 이상 바뀌지 않음)
 */
function cacheSeconds(pathname, q) {
  if (pathname === '/api/status' || pathname === '/api/overview' || pathname === '/api/live' || pathname.startsWith('/api/streams/')) return 60;
  if (pathname === '/api/search') return 300;
  const today = kstDate(nowSec());
  if (q.to && q.to < today) return 3600;
  return 300;
}

function sendJson(res, status, body, cache = 0) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache ? `public, max-age=0, s-maxage=${cache}, stale-while-revalidate=${cache * 4}` : 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(csv);
}

function serveFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

const csvTime = (ts) => new Date((ts + 32400) * 1000).toISOString().slice(0, 16).replace('T', ' ');

function createRoutes(db, cfg) {
  const routes = [];
  const get = (pattern, handler) => routes.push({ pattern, handler });

  get(/^\/api\/status$/, () => Q.status(db, cfg));
  get(/^\/api\/overview$/, () => Q.overview(db, cfg));
  get(/^\/api\/live$/, (q) => Q.liveNow(db, q, cfg));
  get(/^\/api\/rankings$/, async (q, res) => {
    const data = await Q.rankings(db, q);
    if (q.format !== 'csv') return data;
    sendCsv(res, `streaminsight-ranking-${data.from}_${data.to}.csv`, toCsv(data.items, [
      { label: '순위', key: 'rank' },
      { label: '플랫폼', value: (r) => PLATFORM_LABEL[r.platform] || r.platform },
      { label: '채널ID', key: 'channelId' },
      { label: '이름', key: 'name' },
      { label: '평균 시청자', key: 'avgViewers' },
      { label: '최고 시청자', key: 'peakViewers' },
      { label: '시청 시간(h)', value: (r) => r1(r.watchHours) },
      { label: '방송 시간(h)', value: (r) => r1(r.airHours) },
      { label: '방송 일수', key: 'days' },
      { label: '팔로워', key: 'followers' },
      { label: '주 카테고리', key: 'mainCategory' },
    ]));
    return undefined;
  });
  get(/^\/api\/categories$/, async (q, res) => {
    const data = await Q.categories(db, q);
    if (q.format !== 'csv') return data;
    sendCsv(res, `streaminsight-categories-${data.from}_${data.to}.csv`, toCsv(data.items, [
      { label: '순위', key: 'rank' },
      { label: '카테고리', key: 'category' },
      { label: '시청 시간(h)', value: (r) => r1(r.watchHours) },
      { label: '방송 시간(h)', value: (r) => r1(r.airHours) },
      { label: '평균 동시 시청자', key: 'avgConcurrent' },
      { label: '방송당 평균 시청자', key: 'avgPerStream' },
      { label: '최고 시청자', key: 'peak' },
      { label: '방송 채널 수', key: 'channels' },
    ]));
    return undefined;
  });
  get(/^\/api\/categories\/(.+)$/, (q, res, m) => Q.categoryDetail(db, decodeURIComponent(m[1]), q));
  get(/^\/api\/platforms$/, (q) => Q.platformsStats(db, q));
  get(/^\/api\/search$/, (q) => Q.searchChannels(db, q));
  get(/^\/api\/channels\/(\w+)\/([^/]+)$/, async (q, res, m) => {
    const data = await Q.channelDetail(db, m[1], decodeURIComponent(m[2]), q, cfg);
    if (!data) return { status: 404, body: { error: '채널을 찾을 수 없습니다' } };
    if (q.format !== 'csv') return data;
    sendCsv(res, `streaminsight-${data.channel.name || data.channel.channelId}-${data.from}_${data.to}.csv`, toCsv(data.streams, [
      { label: '시작', value: (r) => csvTime(r.startedAt) },
      { label: '종료', value: (r) => (r.endedAt ? csvTime(r.endedAt) : '방송 중') },
      { label: '제목', key: 'title' },
      { label: '카테고리', key: 'category' },
      { label: '평균 시청자', key: 'avgViewers' },
      { label: '최고 시청자', key: 'peakViewers' },
      { label: '방송 시간(h)', value: (r) => r1(r.airHours) },
      { label: '시청 시간(h)', value: (r) => r1(r.watchHours) },
    ]));
    return undefined;
  });
  get(/^\/api\/streams\/(\d+)$/, async (q, res, m) => (await Q.streamDetail(db, Number(m[1]))) ?? { status: 404, body: { error: '방송을 찾을 수 없습니다' } });
  get(/^\/api\/channels-batch$/, (q) => Q.channelsBatch(db, String(q.ids || '').split(',').filter(Boolean), q));
  get(/^\/api\/compare$/, (q) => Q.compare(db, String(q.ids || '').split(',').filter(Boolean), q, cfg));

  return routes;
}

/** 외부 스케줄러(cron-job.org 등)가 호출하는 수집 엔드포인트 */
async function handleCollect(req, res, url, db, cfg) {
  if (!cfg.cronSecret) {
    return sendJson(res, 503, { error: 'CRON_SECRET 환경 변수를 설정해야 수집 엔드포인트를 사용할 수 있습니다' });
  }
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('key');
  if (key !== cfg.cronSecret) return sendJson(res, 401, { error: 'unauthorized' });

  const started = Date.now();
  const work = (async () => {
    const scheduler = createScheduler(db, cfg);
    const result = await scheduler.runOnce();
    // 남는 시간 동안 팔로워 수 갱신 (함수 최대 실행 시간 안에서)
    const followers = await scheduler.updateFollowers({ deadline: started + cfg.collectBudgetMs, perPlatform: 30, delayMs: 100 });
    return { ...result, followersUpdated: followers, durationMs: Date.now() - started };
  })();

  // 서버리스: 외부 스케줄러의 요청 시간 제한(예: cron-job.org 30초)에 걸리지 않도록 바로 응답하고,
  // 수집은 응답 후에도 계속 실행되게 한다. 결과는 /api/status 에서 확인.
  if (cfg.serverless && url.searchParams.get('wait') !== '1') {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(work.catch((err) => console.error('[collect]', err)));
    return sendJson(res, 202, { accepted: true, ts: Math.floor(started / 1000) });
  }
  return sendJson(res, 200, await work);
}

/** API + 정적 파일 처리기. 로컬 http 서버와 Vercel 함수에서 함께 사용 */
export function createHandler(db, cfg) {
  const routes = createRoutes(db, cfg);

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Vercel rewrite(/api/:path* → /api?__path=:path*) 로 들어온 경우 원래 경로 복원
    const rewritten = url.searchParams.get('__path');
    if (rewritten !== null) {
      url.pathname = `/api/${rewritten}`;
      url.searchParams.delete('__path');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/cron/collect') {
        try {
          return await handleCollect(req, res, url, db, cfg);
        } catch (err) {
          console.error(err);
          return sendJson(res, 500, { error: String(err.message || err) });
        }
      }
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const q = Object.fromEntries(url.searchParams);
      for (const r of routes) {
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        try {
          const out = await r.handler(q, res, m);
          if (out === undefined) return undefined;
          if (out && out.status && out.body) return sendJson(res, out.status, out.body);
          return sendJson(res, 200, out, cacheSeconds(url.pathname, q));
        } catch (err) {
          console.error(err);
          return sendJson(res, 500, { error: '서버 오류가 발생했습니다' });
        }
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (VENDOR[pathname]) return serveFile(res, VENDOR[pathname], 'public, max-age=604800');

    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    if (pathname === '/' || !path.extname(pathname)) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return serveFile(res, file);
  };
}

export function createServer(db, cfg) {
  const handle = createHandler(db, cfg);
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: '서버 오류가 발생했습니다' });
    });
  });
}
