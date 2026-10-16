# 스트림인사이트 (StreamInsight)

치지직 · SOOP · 트위치 · 유튜브 한국어 방송의 시청자 통계, 랭킹, 카테고리 분석을 제공하는 웹 서비스입니다.
**유료 멤버십 없이 모든 기능이 무료**이고, 광고도 로그인도 필요 없습니다.

## 주요 기능

| 화면 | 내용 |
| --- | --- |
| 홈 | 플랫폼별 현재 시청자와 어제 같은 시각 대비 변화, 24시간 추이, 점유율, 인기 방송·카테고리, 오늘의 TOP 10 |
| 실시간 | 지금 방송 중인 전체 목록 (플랫폼·카테고리 필터, 검색, 1분 자동 갱신) |
| 랭킹 | 기간(오늘/어제/7일/30일/90일/이번 달/지난 달/직접 선택) × 플랫폼 × 카테고리 × 정렬 기준(시청 시간, 평균·최고 시청자, 방송 시간, 팔로워), 직전 기간 대비 순위 변동, CSV |
| 카테고리 | 카테고리별 시청 시간, 점유율, 평균 동시 시청자, 플랫폼 비중, 카테고리 상세(일별 추이, 인기 스트리머) |
| 플랫폼 | 일별 평균·최고 동시 시청자, 방송 채널 수, 시청 점유율, 시간대별 시청 패턴 |
| 스트리머 | 기간 요약, 플랫폼 내 순위, 일별 그래프, 카테고리 비중, 팔로워 추이, 요일×시간 방송 히트맵, 방송 기록 전체, CSV |
| 방송 상세 | 방송 1회의 시청자 변화 그래프, 카테고리 진행, 채널 평균 대비, 이전·다음 방송 |
| 비교 | 최대 6명 나란히 비교, 지표 전환, 공유 링크 |
| 즐겨찾기 | 로그인 없이 브라우저에 저장, 방송 중 여부와 최근 7일 통계 |

그 밖에 `/` 키로 여는 전역 검색, 라이트/다크 테마, 모바일 화면을 지원합니다.

## 데이터 수집 방식

다른 통계 서비스의 데이터는 쓰지 않습니다. 각 플랫폼의 공개 API를 **주기적으로(기본 5분) 직접 조회**해 방송 중인 목록과 시청자 수를 스냅샷으로 저장합니다.

| 플랫폼 | 사용하는 API |
| --- | --- |
| 치지직 | `GET api.chzzk.naver.com/service/v1/lives` (인기순, 커서 페이지네이션), `GET /service/v1/channels/{id}` (팔로워) |
| SOOP | `GET live.sooplive.co.kr/api/main_broad_list_api.php` (시청자순, 페이지 단위), `GET chapi.sooplive.co.kr/api/{id}/station` (애청자) |
| 트위치 | 공식 Helix API `GET /helix/streams?language=ko`, `/helix/users`, `/helix/channels/followers` (API 키 필요) |
| 유튜브 | 공식 YouTube Data API v3 `search.list`(라이브 발견), `videos.list`(동시 시청자), `channels.list`(프로필·구독자), 채널 RSS (API 키 필요) |

- 시청자 수가 `MIN_VIEWERS` 미만인 방송이 나오면 그 플랫폼의 목록 순회를 멈춥니다.
- 수집 시각은 주기 경계(예: 정각, 5분, 10분…)에 맞춰서 플랫폼끼리 비교하기 쉽게 했습니다.
- 목록에서 2.5주기 넘게 보이지 않은 방송은 종료로 처리합니다.
- 팔로워 수는 방송 중인 상위 채널(`FOLLOWER_TOP_N`)만 하루 한 번 천천히 조회합니다.
- 치지직·SOOP API는 비공식 공개 엔드포인트라 예고 없이 바뀔 수 있습니다. 주소는 환경 변수(`CHZZK_API_BASE`, `SOOP_LIST_API`, `SOOP_STATION_API`)로 바꿀 수 있고, 응답 파싱은 `src/collectors/`에 모여 있습니다.

### 유튜브 수집과 쿼터

유튜브는 다른 플랫폼처럼 "지금 방송 중인 전체 목록" API가 없고, 하루 쿼터(기본 10,000단위)가 있어서 두 단계로 나눠 수집합니다.

| 단계 | API | 비용 | 기본 주기 | 하루 사용량(대략) |
| --- | --- | --- | --- | --- |
| 새 라이브 찾기 | `search.list` (eventType=live, regionCode=KR, 시청자순) | 1페이지(50개) 100단위 | 1시간마다 2페이지 | 4,800 |
| 시청자 추적 | `videos.list` (찾아둔 방송 + 방송 중 영상) | 50개당 1단위 | 5분 | 방송 150개 기준 약 860 |
| 채널 정보·구독자 | `channels.list` | 50개당 1단위 / 채널당 1단위 | 새 채널 · 하루 1회 | 수백 |
| 지정 채널 | 채널 RSS 피드 | 쿼터 없음 | 10분 | 0 |

- 검색 결과에 없던 방송도 `YOUTUBE_CHANNEL_IDS`에 넣은 채널은 RSS로 확인해 놓치지 않습니다.
- 한국어 방송(제목·채널명에 한글, 또는 언어 설정 ko)만 수집하고, 24시간 뉴스 라이브가 순위를 덮지 않도록 뉴스/정치 카테고리는 기본 제외합니다.
- 동시 시청자 수를 숨긴 방송은 집계할 수 없어 제외됩니다.
- 유튜브 카테고리는 영상 카테고리(게임, 음악, 엔터테인먼트 등)라서, 게임 방송의 게임 이름까지는 나오지 않습니다.
- 쿼터가 `YOUTUBE_QUOTA_RESERVE` 이하로 남으면 검색을 멈추고 이미 찾은 방송의 추적만 계속합니다.

### 지표 정의

- **평균 시청자**: 방송 중 동시 시청자 수의 시간 가중 평균 (`Σ 시청자×시간 / Σ 방송 시간`)
- **최고 시청자**: 수집 시점 중 가장 높았던 동시 시청자 수
- **시청 시간**(뷰어십): `Σ 시청자 × 시간`. 평균 1,000명이 2시간 방송하면 2,000시간
- 한 스냅샷이 대표하는 시간은 직전 수집과의 간격이며, 수집이 끊겼을 때 부풀지 않도록 최대 2주기로 제한합니다.
- 날짜는 모두 한국 시간(KST) 기준입니다.

## 실행

Node.js 20 이상(권장 22)이 필요합니다. 로컬에서는 데이터베이스가 `data/` 폴더의 파일로 만들어지므로 따로 설치할 것이 없습니다. 배포용 원격 DB는 [Turso](https://turso.tech)(SQLite 호환)를 씁니다.

```bash
npm install
cp .env.example .env     # 필요하면 설정 수정 (트위치·유튜브 API 키 등)
npm start                # 웹 서버 + 수집기 → http://localhost:3000
```

- `npm run collect:once` : 한 번만 수집하고 종료 (cron 등으로 돌릴 때)
- `npm run demo` : 가상 데모 데이터 30일치를 만들어 `data/demo.db`로 실행 (API 접근 없이 화면 확인용)
- `npm test` : 테스트 실행

트위치를 수집하려면 [Twitch 개발자 콘솔](https://dev.twitch.tv/console/apps)에서 앱을 만들고 `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`을 설정하세요. 키가 없으면 트위치만 건너뜁니다.

유튜브를 수집하려면 [Google Cloud 콘솔](https://console.cloud.google.com/apis/library/youtube.googleapis.com)에서 YouTube Data API v3를 사용 설정하고 API 키를 만들어 `YOUTUBE_API_KEY`에 넣으세요. 키가 없으면 유튜브만 건너뜁니다.

## Vercel 배포

Vercel은 요청이 올 때만 함수가 잠깐 실행되므로, 서버 안의 파일 DB나 계속 도는 수집기를 쓸 수 없습니다. 그래서 다음처럼 나눕니다.

- **화면**: `public/` 정적 파일 (Vercel CDN)
- **API**: `api/index.js` 함수 하나가 `/api/*`를 모두 처리 (서울 리전 `icn1`, 응답은 CDN에 캐시)
- **DB**: Turso (원격 SQLite)
- **수집**: 외부 스케줄러(cron-job.org 등)가 `/api/cron/collect`를 주기적으로 호출. Vercel 무료(Hobby) 플랜의 크론은 하루 1번만 돌 수 있어서 외부 스케줄러를 씁니다.

### 1. Turso DB 만들기
1. [turso.tech](https://turso.tech)에 가입하고 데이터베이스를 만듭니다. 리전은 서울과 가까운 **Tokyo**를 권장합니다.
2. 데이터베이스 화면에서 **URL**(`libsql://...`)을 복사하고, **Create Token**으로 토큰을 만듭니다.
   - CLI를 쓴다면 `turso db show <이름> --url`, `turso db tokens create <이름>`
3. 표(테이블)는 첫 요청 때 자동으로 만들어집니다.

### 2. Vercel 환경 변수
Vercel 프로젝트 → Settings → Environment Variables 에 추가하고 다시 배포(Redeploy)합니다.

| 변수 | 예시 / 설명 |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://streaminsight-xxx.turso.io` |
| `TURSO_AUTH_TOKEN` | Turso에서 만든 토큰 |
| `CRON_SECRET` | 아무도 모르는 긴 임의 문자열 (수집 주소 보호용) |
| `COLLECT_INTERVAL_SEC` | `600` (외부 스케줄러 주기와 같게. 10분 권장) |
| `MIN_VIEWERS` | `30` (Turso 무료 한도 안에서 쓰기 위한 권장값, 아래 참고) |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | 트위치를 받을 때 |
| `YOUTUBE_API_KEY` | 유튜브를 받을 때 |

### 3. 수집 스케줄러 (cron-job.org)
1. [cron-job.org](https://cron-job.org)에 가입하고 **Create cronjob**
2. URL: `https://<내 도메인>/api/cron/collect`
3. 실행 주기: `COLLECT_INTERVAL_SEC`와 같게 (예: 10분마다)
4. Advanced → Headers 에 `Authorization` = `Bearer <CRON_SECRET 값>` 추가
5. 저장 후 몇 분 뒤 사이트의 **안내** 페이지에서 플랫폼별 수집 상태를 확인합니다.

수집 주소는 바로 `202`로 응답하고, 수집은 응답 뒤에 계속 진행됩니다(스케줄러의 요청 시간 제한 대비). 결과를 기다려 받고 싶으면 주소 끝에 `?wait=1`을 붙이세요.

### Turso 무료 한도와 권장 설정
Turso 무료 플랜은 한 달에 **쓰기 1,000만 행, 읽기 5억 행**입니다.

- **쓰기**: 방송 1개를 한 번 수집할 때 약 1행을 씁니다. 월 쓰기량 ≈ 수집되는 방송 수 × 한 달 수집 횟수. 예) 방송 2,000개 × 10분 주기(월 4,320회) ≈ 860만 행
- 방송 수는 `MIN_VIEWERS`(이보다 적은 시청자의 방송은 수집 안 함)로 조절합니다. 안내 페이지에 지금 기준 **월 쓰기량 추정치**가 나오니 보고 조정하세요.
- **읽기**: 같은 요청은 CDN 캐시로 응답합니다(실시간 1분, 오늘 포함 기간 5분, 지난 기간 1시간). 그래도 방문이 많아지면 한도를 넘을 수 있습니다.
- 한도를 넘기 쉬우면 Turso 유료 플랜(월 약 5달러, 쓰기 2,500만 행)을 쓰거나 수집 주기를 늘리세요.

### 주의
- 치지직·SOOP API가 해외·클라우드 IP의 요청을 막으면 Vercel에서는 수집이 실패할 수 있습니다. 안내 페이지에서 플랫폼별 오류를 확인하세요. 그런 경우 수집만 국내 PC나 서버에서 `npm run collect:once`(같은 Turso 주소 사용)로 돌리는 방법이 있습니다.

### 설정 (`.env`)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | 3000 | 웹 서버 포트 |
| `DB_PATH` | `data/streaminsight.db` | SQLite 파일 |
| `COLLECT_INTERVAL_SEC` | 300 | 수집 주기(초) |
| `PLATFORMS` | `chzzk,soop,twitch,youtube` | 수집할 플랫폼 |
| `MIN_VIEWERS` | 5 | 이 인원 미만 방송은 수집 안 함 |
| `MAX_PAGES` | 40 | 플랫폼별 목록 최대 페이지 |
| `SNAPSHOT_RETENTION_DAYS` | 180 | 방송별 시청자 그래프(timeline) 보관 기간. 방송 요약과 일별 집계는 영구 보관 |
| `FOLLOWER_TOP_N` | 300 | 팔로워를 갱신할 상위 채널 수 |
| `ENABLE_COLLECTOR` | true | false면 웹 서버만 실행 |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | | 원격 DB (없으면 `DB_PATH` 파일 사용) |
| `CRON_SECRET` | | `/api/cron/collect` 호출용 비밀키 |
| `COLLECT_BUDGET_MS` | 45000 | 수집 엔드포인트 1회 실행 시간 예산 (팔로워 갱신 포함) |
| `YOUTUBE_API_KEY` | | 유튜브 Data API 키 |
| `YOUTUBE_CHANNEL_IDS` | | 꼭 추적할 유튜브 채널 ID (쉼표 구분) |
| `YOUTUBE_SEARCH_INTERVAL_MIN` / `YOUTUBE_SEARCH_PAGES` | 60 / 2 | 새 라이브 검색 주기(분)와 페이지 수 |
| `YOUTUBE_KOREAN_ONLY` | true | 한국어 방송만 수집 |
| `YOUTUBE_EXCLUDE_CATEGORIES` | 25 | 제외할 유튜브 카테고리 ID (25=뉴스/정치) |
| `YOUTUBE_DAILY_QUOTA` / `YOUTUBE_QUOTA_RESERVE` | 10000 / 2000 | 하루 쿼터, 추적용으로 남길 쿼터 |

## 구조

```
api/index.js    Vercel 함수 진입점 (/api/* 전부 처리)
src/
  collectors/   플랫폼별 수집기 (치지직, SOOP, 트위치, 유튜브) - API 응답을 공통 형식으로 정규화
  ingest.js     수집 결과 저장, 방송 시작·종료 판정, 일별 집계
  scheduler.js  수집 실행(상시 실행/엔드포인트 호출), 팔로워 갱신, 오래된 기록 정리
  queries.js    랭킹·카테고리·플랫폼·채널·비교 통계 쿼리
  web.js        API 라우터와 정적 파일 서버 (로컬·Vercel 공용)
  main.js       로컬 실행 진입점 (npm start)
public/         프런트엔드 (빌드 과정 없는 ES 모듈 + Chart.js)
scripts/        데모 데이터 생성기, 빌드 스크립트
test/           node:test 테스트
vercel.json     Vercel 설정 (정적 파일, 함수, 리전, rewrite)
```

### 저장 구조

DB 쓰기 행 수를 줄이도록 설계했습니다.

- `streams` : 방송 1회 단위. 시청자 그래프(`timeline`), 카테고리 변경 구간(`segments`), 방송 중 일자별 집계(`day_stats`)를 한 행에 담아, 수집 1회에 방송당 1행만 갱신합니다.
- `daily` : KST 일자 × 채널 × 카테고리 집계. 방송이 끝날 때 `day_stats`를 옮겨 적습니다. 랭킹·통계는 `daily`와 방송 중인 `day_stats`를 합쳐 계산합니다.
- `platform_snapshots` : 플랫폼 전체 동시 시청자
- `channels`, `follower_history`, `collector_status`
- `kv` : 수집기 상태 (유튜브 쿼터·후보 영상, 트위치 토큰 등)

### API

| 경로 | 설명 |
| --- | --- |
| `GET /api/overview` | 홈 화면 데이터 |
| `GET /api/live?platform&category&q&limit` | 방송 중 목록 |
| `GET /api/rankings?from&to&platform&category&sort&q&limit&offset[&format=csv]` | 스트리머 랭킹 |
| `GET /api/categories?from&to&platform[&format=csv]`, `/api/categories/{이름}` | 카테고리 |
| `GET /api/platforms?from&to` | 플랫폼 비교 |
| `GET /api/channels/{platform}/{id}?from&to[&format=csv]` | 스트리머 상세 |
| `GET /api/streams/{id}` | 방송 상세 |
| `GET /api/compare?ids=chzzk:id,soop:id` | 비교 |
| `GET /api/search?q` | 스트리머 검색 |
| `GET /api/status` | 수집 상태, 월 쓰기량 추정 |
| `GET/POST /api/cron/collect` | 수집 1회 실행 (`Authorization: Bearer <CRON_SECRET>` 필요) |
