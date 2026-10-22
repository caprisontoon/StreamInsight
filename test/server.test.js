import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { migrate, openDb } from '../src/db.js';
import { ingest } from '../src/ingest.js';
import { createServer } from '../src/web.js';
import { nowSec } from '../src/util.js';

let server;
let base;
const cfg = { intervalSec: 300, demo: false, minViewers: 5, enableCollector: false, cronSecret: 'secret', platforms: [], collectBudgetMs: 1000, followerTopN: 0, snapshotRetentionDays: 180 };

before(async () => {
  const db = openDb('file::memory:');
  await migrate(db);
  const ts = Math.floor(nowSec() / 300) * 300;
  await ingest(db, 'chzzk', [{ channelId: 'c1', channelName: '<script>x</script>', streamKey: 'k1', title: 't', category: '토크', viewers: 77 }], ts, 300);
  server = createServer(db, cfg);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('주요 API 응답', async () => {
  for (const path of ['/api/status', '/api/overview', '/api/live', '/api/rankings', '/api/categories', '/api/platforms', '/api/compare?ids=chzzk:c1']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    await res.json();
  }
  const o = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(o.top[0].viewers, 77);
});

test('CSV 내려받기', async () => {
  const res = await fetch(`${base}/api/rankings?format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const text = await res.text();
  assert.match(text, /순위,플랫폼/);
});

test('없는 채널은 404, 정적 파일 경로 이탈 차단', async () => {
  assert.equal((await fetch(`${base}/api/channels/chzzk/nope`)).status, 404);
  const res = await fetch(`${base}/..%2Fpackage.json`);
  assert.notEqual(res.status, 200);
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /스트림인사이트/);
});

test('캐시 헤더: 지난 기간은 길게, 실시간은 짧게', async () => {
  const live = await fetch(`${base}/api/overview`);
  assert.match(live.headers.get('cache-control'), /s-maxage=60/);
  const past = await fetch(`${base}/api/rankings?from=2020-01-01&to=2020-01-07`);
  assert.match(past.headers.get('cache-control'), /s-maxage=3600/);
});

test('수집 엔드포인트는 비밀키가 필요하다', async () => {
  assert.equal((await fetch(`${base}/api/cron/collect`)).status, 401);
  assert.equal((await fetch(`${base}/api/cron/collect?key=wrong`)).status, 401);
  const ok = await fetch(`${base}/api/cron/collect`, { headers: { Authorization: 'Bearer secret' } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(Array.isArray(body.results));
});

test('Vercel rewrite 형태(__path)도 처리한다', async () => {
  const res = await fetch(`${base}/api/index?__path=rankings&limit=1`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).items));
});
