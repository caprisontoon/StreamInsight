import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

/**
 * 저장소: libSQL (Turso 호환 SQLite)
 *  - 로컬: file:data/streaminsight.db
 *  - 배포(Vercel 등): TURSO_DATABASE_URL=libsql://... + TURSO_AUTH_TOKEN
 *
 * Turso 요금은 "읽은 행 / 쓴 행" 기준이라, 수집 주기마다 쓰는 행 수를 줄이도록 설계했다.
 *  - 방송별 시청자 기록(timeline)과 카테고리 구간(segments)은 streams 행 하나에 이어 붙인다
 *  - 방송 중인 동안의 일자별 집계는 streams.day_stats(JSON)에 두고, 방송이 끝날 때 daily 로 옮긴다
 *  → 방송 1개당 수집 1회에 쓰기 1행
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  platform TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT,
  login TEXT,
  image_url TEXT,
  followers INTEGER,
  followers_updated_at INTEGER,
  first_seen_at INTEGER,
  last_live_at INTEGER,
  PRIMARY KEY (platform, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);

CREATE TABLE IF NOT EXISTS streams (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT,
  category TEXT,
  thumbnail TEXT,
  adult INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  current_viewers INTEGER DEFAULT 0,
  peak_viewers INTEGER DEFAULT 0,
  viewer_sec INTEGER DEFAULT 0,
  air_sec INTEGER DEFAULT 0,
  samples INTEGER DEFAULT 0,
  timeline TEXT,
  segments TEXT,
  day_stats TEXT,
  UNIQUE (platform, stream_key)
);
CREATE INDEX IF NOT EXISTS idx_streams_channel ON streams(platform, channel_id, started_at);
CREATE INDEX IF NOT EXISTS idx_streams_open ON streams(ended_at, platform);
CREATE INDEX IF NOT EXISTS idx_streams_seen ON streams(platform, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_streams_started ON streams(started_at);

CREATE TABLE IF NOT EXISTS platform_snapshots (
  platform TEXT NOT NULL,
  ts INTEGER NOT NULL,
  viewers INTEGER NOT NULL,
  channels INTEGER NOT NULL,
  PRIMARY KEY (platform, ts)
);
CREATE INDEX IF NOT EXISTS idx_psnap_ts ON platform_snapshots(ts);

CREATE TABLE IF NOT EXISTS daily (
  date TEXT NOT NULL,
  platform TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  category TEXT NOT NULL,
  viewer_sec INTEGER NOT NULL DEFAULT 0,
  air_sec INTEGER NOT NULL DEFAULT 0,
  peak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, platform, channel_id, category)
);
CREATE INDEX IF NOT EXISTS idx_daily_channel ON daily(platform, channel_id, date);
CREATE INDEX IF NOT EXISTS idx_daily_category ON daily(category, date);

CREATE TABLE IF NOT EXISTS follower_history (
  platform TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  date TEXT NOT NULL,
  followers INTEGER NOT NULL,
  PRIMARY KEY (platform, channel_id, date)
);

CREATE TABLE IF NOT EXISTS collector_status (
  platform TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  live_count INTEGER,
  total_viewers INTEGER,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);
`;

export function openDb(cfg) {
  const url = typeof cfg === 'string' ? cfg : cfg.dbUrl;
  if (url.startsWith('file:') && !url.includes(':memory:')) {
    fs.mkdirSync(path.dirname(path.resolve(url.slice(5))), { recursive: true });
  }
  return createClient({ url, authToken: typeof cfg === 'string' ? undefined : cfg.dbAuthToken || undefined });
}

const migrated = new WeakSet();
export async function migrate(db) {
  if (migrated.has(db)) return;
  await db.executeMultiple(SCHEMA);
  migrated.add(db);
}

export async function all(db, sql, args = []) {
  return (await db.execute({ sql, args })).rows;
}

export async function get(db, sql, args = []) {
  return (await db.execute({ sql, args })).rows[0];
}

export async function run(db, sql, args = []) {
  return db.execute({ sql, args });
}

/** 문장 묶음을 나눠서 batch 실행 (각 묶음은 하나의 트랜잭션) */
export async function batch(db, statements, size = 400) {
  for (let i = 0; i < statements.length; i += size) {
    await db.batch(statements.slice(i, i + size), 'write');
  }
}

export async function kvGet(db, key, fallback = null) {
  const r = await get(db, 'SELECT value FROM kv WHERE key = ?', [key]);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value);
  } catch {
    return fallback;
  }
}

export async function kvSet(db, key, value, ts = Math.floor(Date.now() / 1000)) {
  await run(db, `
    INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, JSON.stringify(value), ts]);
}
