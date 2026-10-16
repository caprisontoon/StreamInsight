// Vercel 함수: /api/* 요청을 모두 처리 (vercel.json 의 rewrite 참고)
import { config } from '../src/config.js';
import { migrate, openDb } from '../src/db.js';
import { createHandler } from '../src/web.js';

let ready = null;

function init() {
  if (!config.dbUrl.startsWith('libsql:') && !config.dbUrl.startsWith('https:') && !config.dbUrl.startsWith('wss:')) {
    throw new Error('TURSO_DATABASE_URL 환경 변수를 설정해 주세요. Vercel 에서는 로컬 파일 DB를 사용할 수 없습니다.');
  }
  const db = openDb(config);
  return migrate(db).then(() => createHandler(db, config));
}

export default async function handler(req, res) {
  try {
    ready ??= init();
    const handle = await ready;
    await handle(req, res);
  } catch (err) {
    ready = null;
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}
