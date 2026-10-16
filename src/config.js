import path from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // .env 파일이 없으면 환경 변수만 사용
}

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v, d) => (v === undefined || v === '' ? d : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));

export const config = {
  port: int(env.PORT, 3000),
  dbPath: path.resolve(env.DB_PATH || 'data/streaminsight.db'),
  intervalSec: int(env.COLLECT_INTERVAL_SEC, 300),
  platforms: (env.PLATFORMS || 'chzzk,soop,twitch,youtube').split(',').map((s) => s.trim()).filter(Boolean),
  minViewers: int(env.MIN_VIEWERS, 5),
  maxPages: int(env.MAX_PAGES, 40),
  snapshotRetentionDays: int(env.SNAPSHOT_RETENTION_DAYS, 180),
  followerTopN: int(env.FOLLOWER_TOP_N, 300),
  enableCollector: bool(env.ENABLE_COLLECTOR, true),
  demo: bool(env.DEMO, false),
  chzzkApiBase: env.CHZZK_API_BASE || 'https://api.chzzk.naver.com',
  soopListApi: env.SOOP_LIST_API || 'https://live.sooplive.co.kr/api/main_broad_list_api.php',
  soopStationApi: env.SOOP_STATION_API || 'https://chapi.sooplive.co.kr/api',
  twitchClientId: env.TWITCH_CLIENT_ID || '',
  twitchClientSecret: env.TWITCH_CLIENT_SECRET || '',
  twitchLanguage: env.TWITCH_LANGUAGE || 'ko',
  youtubeApiKey: env.YOUTUBE_API_KEY || '',
  youtubeChannelIds: list(env.YOUTUBE_CHANNEL_IDS),
  youtubeSearchIntervalMin: int(env.YOUTUBE_SEARCH_INTERVAL_MIN, 60),
  youtubeSearchPages: int(env.YOUTUBE_SEARCH_PAGES, 2),
  youtubeRssIntervalMin: int(env.YOUTUBE_RSS_INTERVAL_MIN, 10),
  youtubeRegion: env.YOUTUBE_REGION || 'KR',
  youtubeLanguage: env.YOUTUBE_LANGUAGE || 'ko',
  youtubeKoreanOnly: bool(env.YOUTUBE_KOREAN_ONLY, true),
  youtubeExcludeCategories: list(env.YOUTUBE_EXCLUDE_CATEGORIES ?? '25'),
  youtubeDailyQuota: int(env.YOUTUBE_DAILY_QUOTA, 10000),
  youtubeQuotaReserve: int(env.YOUTUBE_QUOTA_RESERVE, 2000),
};

export const PLATFORMS = {
  chzzk: { id: 'chzzk', name: '치지직' },
  soop: { id: 'soop', name: 'SOOP' },
  twitch: { id: 'twitch', name: '트위치' },
  youtube: { id: 'youtube', name: '유튜브' },
};
