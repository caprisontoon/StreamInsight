import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Q from './queries.js';
import { toCsv } from './util.js';

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
  '.webmanifest': 'application/manifest+json',
};

const PLATFORM_LABEL = { chzzk: '치지직', soop: 'SOOP', twitch: '트위치', youtube: '유튜브' };
const r1 = (n) => Math.round(n * 10) / 10;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
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

export function createRoutes(db, cfg) {
  const routes = [];
  const get = (pattern, handler) => routes.push({ pattern, handler });

  get(/^\/api\/status$/, () => Q.status(db, cfg));
  get(/^\/api\/overview$/, () => Q.overview(db, cfg));
  get(/^\/api\/live$/, (q) => Q.liveNow(db, q, cfg));
  get(/^\/api\/rankings$/, (q, res) => {
    const data = Q.rankings(db, q);
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
  get(/^\/api\/categories$/, (q, res) => {
    const data = Q.categories(db, q);
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
  get(/^\/api\/channels\/(\w+)\/([^/]+)$/, (q, res, m) => {
    const data = Q.channelDetail(db, m[1], decodeURIComponent(m[2]), q);
    if (!data) return { status: 404, body: { error: '채널을 찾을 수 없습니다' } };
    if (q.format !== 'csv') return data;
    sendCsv(res, `streaminsight-${data.channel.name || data.channel.channelId}-${data.from}_${data.to}.csv`, toCsv(data.streams, [
      { label: '시작', value: (r) => new Date((r.startedAt + 32400) * 1000).toISOString().slice(0, 16).replace('T', ' ') },
      { label: '종료', value: (r) => (r.endedAt ? new Date((r.endedAt + 32400) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '방송 중') },
      { label: '제목', key: 'title' },
      { label: '카테고리', key: 'category' },
      { label: '평균 시청자', key: 'avgViewers' },
      { label: '최고 시청자', key: 'peakViewers' },
      { label: '방송 시간(h)', value: (r) => r1(r.airHours) },
      { label: '시청 시간(h)', value: (r) => r1(r.watchHours) },
    ]));
    return undefined;
  });
  get(/^\/api\/streams\/(\d+)$/, (q, res, m) => Q.streamDetail(db, Number(m[1])) ?? { status: 404, body: { error: '방송을 찾을 수 없습니다' } });
  get(/^\/api\/channels-batch$/, (q) => Q.channelsBatch(db, String(q.ids || '').split(',').filter(Boolean), q));
  get(/^\/api\/compare$/, (q) => Q.compare(db, String(q.ids || '').split(',').filter(Boolean), q));

  return routes;
}

export function createServer(db, cfg) {
  const routes = createRoutes(db, cfg);

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const q = Object.fromEntries(url.searchParams);
      for (const r of routes) {
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        try {
          const out = r.handler(q, res, m);
          if (out === undefined) return undefined;
          if (out && out.status && out.body) return sendJson(res, out.status, out.body);
          return sendJson(res, 200, out);
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
  });
}
