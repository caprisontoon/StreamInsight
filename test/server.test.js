import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { ingest } from '../src/ingest.js';
import { createServer } from '../src/server.js';
import { nowSec } from '../src/util.js';

let server;
let base;
const cfg = { intervalSec: 300, demo: false, minViewers: 5, enableCollector: false };

before(async () => {
  const db = openDb(':memory:');
  const ts = Math.floor(nowSec() / 300) * 300;
  ingest(db, 'chzzk', [{ channelId: 'c1', channelName: '<script>x</script>', streamKey: 'k1', title: 't', category: '토크', viewers: 77 }], ts, 300);
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
