import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
CREATE INDEX IF NOT EXISTS idx_channels_last_live ON channels(last_live_at);

-- 방송(라이브 1회) 단위 집계
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
  UNIQUE (platform, stream_key)
);
CREATE INDEX IF NOT EXISTS idx_streams_channel ON streams(platform, channel_id, started_at);
CREATE INDEX IF NOT EXISTS idx_streams_open ON streams(ended_at, platform);
CREATE INDEX IF NOT EXISTS idx_streams_started ON streams(started_at);

-- 수집 주기마다 기록되는 방송별 시청자 수
CREATE TABLE IF NOT EXISTS snapshots (
  stream_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  viewers INTEGER NOT NULL,
  dur INTEGER NOT NULL,
  category TEXT
);
CREATE INDEX IF NOT EXISTS idx_snap_stream ON snapshots(stream_id, ts);
CREATE INDEX IF NOT EXISTS idx_snap_channel ON snapshots(platform, channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON snapshots(ts);

-- 플랫폼 전체 동시 시청자 / 방송 수
CREATE TABLE IF NOT EXISTS platform_snapshots (
  platform TEXT NOT NULL,
  ts INTEGER NOT NULL,
  viewers INTEGER NOT NULL,
  channels INTEGER NOT NULL,
  PRIMARY KEY (platform, ts)
);
CREATE INDEX IF NOT EXISTS idx_psnap_ts ON platform_snapshots(ts);

-- KST 일자 × 채널 × 카테고리 집계 (랭킹/통계의 기반, 영구 보관)
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
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** 콜백을 하나의 트랜잭션으로 실행 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
