/**
 * 데모용 가상 데이터 생성기.
 * 실제 플랫폼 API에 접근할 수 없는 환경에서 화면을 확인할 수 있도록,
 * 가상의 스트리머 방송을 실제 수집기와 같은 경로(ingest)로 30일치 기록한다.
 * 모든 채널·방송은 가상이며 실제 인물/채널과 무관하다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { ingest, recordFollowers, recordStatus } from '../src/ingest.js';
import { kstDate, nowSec } from '../src/util.js';

const DB_PATH = path.resolve(process.env.DEMO_DB_PATH || 'data/demo.db');
const DAYS = Number(process.env.DEMO_DAYS || 30);
const INTERVAL = Number(process.env.COLLECT_INTERVAL_SEC || 300);

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
const db = openDb(DB_PATH);

let seed = 20261016;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

const ADJ = ['졸린', '푸른', '수상한', '용감한', '느긋한', '반짝이는', '배고픈', '조용한', '신난', '차가운', '따뜻한', '엉뚱한', '빠른', '작은', '거대한', '은밀한', '행복한', '새벽의', '전설의', '귀여운'];
const NOUN = ['고양이', '여우', '펭귄', '고래', '토끼', '판다', '부엉이', '다람쥐', '호랑이', '수달', '해파리', '거북이', '참새', '늑대', '햄스터', '라쿤', '돌고래', '코알라', '두더지', '사막여우'];
const KR_CATS = ['토크', '리그 오브 레전드', '발로란트', '배틀그라운드', '메이플스토리', '마인크래프트', '종합 게임', '버추얼', '노래/음악', '스포츠', '전략적 팀 전투', '스타크래프트', '로스트아크', '먹방/쿡방', 'FC 온라인'];
const TW_CATS = ['Just Chatting', 'League of Legends', 'VALORANT', 'Minecraft', 'PUBG: BATTLEGROUNDS', 'Teamfight Tactics', 'Lost Ark', 'Music', 'Overwatch 2', 'Apex Legends'];
const TITLES = ['오늘도 달린다', '랭크 올리기 도전', '시청자 참여 게임', '수다 한 판', '신작 첫 플레이', '합방 with 친구들', '새벽 감성 방송', '대회 연습', '구독자 이벤트', '느긋한 저녁 방송', '공략 연구 중', '노래 신청 받아요'];

const usedNames = new Set();
function makeName() {
  for (;;) {
    const n = `${pick(ADJ)}${pick(NOUN)}${rand() < 0.3 ? Math.floor(rand() * 99) + 1 : ''}`;
    if (!usedNames.has(n)) {
      usedNames.add(n);
      return n;
    }
  }
}

const PLATFORM_SETUP = { chzzk: { count: 80, scale: 1.0, cats: KR_CATS }, soop: { count: 80, scale: 1.1, cats: KR_CATS }, twitch: { count: 30, scale: 0.35, cats: TW_CATS } };

const channels = [];
for (const [platform, setup] of Object.entries(PLATFORM_SETUP)) {
  for (let i = 0; i < setup.count; i++) {
    const popularity = Math.round(Math.exp(3.4 + Math.abs(gauss()) * 1.9) * setup.scale) + 10; // 롱테일 분포
    const mainCat = pick(setup.cats);
    channels.push({
      platform,
      id: platform === 'soop' ? `demo${platform}${i}` : `demo-${platform}-${String(i).padStart(3, '0')}`,
      name: makeName(),
      popularity,
      growth: 1 + gauss() * 0.15, // 30일간 인기 변화율
      cats: [mainCat, mainCat, mainCat, pick(setup.cats), pick(setup.cats)],
      startHour: rand() < 0.15 ? Math.floor(rand() * 5) : 12 + Math.floor(rand() * 10),
      hours: 2 + rand() * 7,
      liveProb: 0.45 + rand() * 0.45,
      followers: Math.round(popularity * (25 + rand() * 40)),
      sessions: new Map(),
    });
  }
}

const end = Math.floor(nowSec() / INTERVAL) * INTERVAL;
const start = end - DAYS * 86400;
let streamSeq = 1;

/** 채널의 해당 날짜 방송 일정 (KST) */
function sessionFor(ch, dayIndex) {
  if (ch.sessions.has(dayIndex)) return ch.sessions.get(dayIndex);
  let s = null;
  if (rand() < ch.liveProb) {
    const dayStart = start - ((start + 9 * 3600) % 86400) + dayIndex * 86400; // KST 자정
    const begin = dayStart + (ch.startHour + gauss() * 1.2) * 3600;
    const len = Math.max(1, ch.hours + gauss() * 1.5) * 3600;
    s = {
      key: String(streamSeq++),
      begin: Math.round(begin),
      end: Math.round(begin + len),
      title: `${pick(TITLES)} ${rand() < 0.4 ? '🔥' : ''}`.trim(),
      cats: [pick(ch.cats), rand() < 0.3 ? pick(ch.cats) : null],
      mood: 0.7 + rand() * 0.7,
    };
  }
  ch.sessions.set(dayIndex, s);
  return s;
}

console.log(`데모 데이터 생성: ${channels.length}개 채널, ${DAYS}일, ${INTERVAL}초 간격 → ${DB_PATH}`);
const t0 = Date.now();
for (let ts = start; ts <= end; ts += INTERVAL) {
  const dayIdx = Math.floor((ts - (start - ((start + 9 * 3600) % 86400))) / 86400);
  const progress = (ts - start) / (end - start);
  const dow = new Date((ts + 9 * 3600) * 1000).getUTCDay();
  const weekend = dow === 0 || dow === 6 ? 1.18 : 1;
  const byPlatform = { chzzk: [], soop: [], twitch: [] };

  for (const ch of channels) {
    for (const d of [dayIdx - 1, dayIdx]) {
      const s = d >= 0 ? sessionFor(ch, d) : null;
      if (!s || ts < s.begin || ts > s.end) continue;
      const elapsed = (ts - s.begin) / (s.end - s.begin);
      const ramp = Math.min(1, (ts - s.begin) / 2400) * (1 - 0.25 * Math.max(0, elapsed - 0.7));
      const trend = 1 + (ch.growth - 1) * progress;
      const viewers = Math.max(0, Math.round(ch.popularity * s.mood * ramp * trend * weekend * (1 + gauss() * 0.06)));
      if (viewers < 5) continue;
      const cat = s.cats[1] && elapsed > 0.55 ? s.cats[1] : s.cats[0];
      byPlatform[ch.platform].push({
        channelId: ch.id,
        login: ch.id,
        channelName: ch.name,
        streamKey: `${ch.platform}-${s.key}`,
        title: s.title,
        category: cat,
        viewers,
        startedAt: s.begin,
      });
    }
  }
  for (const [platform, items] of Object.entries(byPlatform)) {
    ingest(db, platform, items, ts, INTERVAL);
  }

  // 하루 한 번 팔로워 기록
  if ((ts + 9 * 3600) % 86400 === 0 || ts === end) {
    db.exec('BEGIN');
    for (const ch of channels) {
      ch.followers = Math.round(ch.followers * (1 + 0.002 + (ch.growth - 1) * 0.01 + gauss() * 0.001));
      recordFollowers(db, ch.platform, ch.id, ch.followers, ts);
    }
    db.exec('COMMIT');
  }
}

for (const platform of Object.keys(PLATFORM_SETUP)) {
  const p = db.prepare('SELECT viewers, channels FROM platform_snapshots WHERE platform = ? ORDER BY ts DESC LIMIT 1').get(platform);
  recordStatus(db, platform, { ts: end, ok: true, liveCount: p?.channels ?? 0, totalViewers: p?.viewers ?? 0, durationMs: 0 });
}

const c = db.prepare('SELECT (SELECT COUNT(*) FROM streams) s, (SELECT COUNT(*) FROM snapshots) n').get();
console.log(`완료 (${((Date.now() - t0) / 1000).toFixed(1)}초): 방송 ${c.s}개, 스냅샷 ${c.n.toLocaleString()}개, 마지막 날짜 ${kstDate(end)}`);
db.close();
