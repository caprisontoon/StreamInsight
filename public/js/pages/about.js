import { api } from '../api.js';
import { ago, html, num, platformName } from '../ui.js';

export async function render(ctx) {
  const s = await api('status', {}, { fresh: true }).catch(() => null);
  if (!ctx.isCurrent()) return;
  ctx.el.innerHTML = String(html`
    <div class="prose">
      <div class="page-head"><div><h1>스트림인사이트 안내</h1><p>한국 인터넷 방송 시청자 통계를 누구나 무료로</p></div></div>

      <div class="card">
        <h2 style="margin-top:0">모든 기능 무료</h2>
        <p>유료 멤버십이나 광고 없이 아래 기능을 모두 제공합니다.</p>
        <ul>
          <li>스트리머별 <b>방송 상세 통계</b>: 방송 1회 단위의 시청자 변화 그래프, 카테고리 진행</li>
          <li><b>기간 제한 없는 기록 조회</b>: 오늘, 7일, 30일, 90일, 원하는 날짜 직접 선택</li>
          <li>방송 시간대 <b>히트맵</b>, 카테고리 비중, 팔로워 추이</li>
          <li>최대 6명 <b>스트리머 비교</b>와 공유 링크</li>
          <li>랭킹·카테고리·방송 기록 <b>CSV 내려받기</b></li>
          <li>로그인 없이 쓰는 <b>즐겨찾기</b> (브라우저에 저장)</li>
        </ul>
      </div>

      <h2>데이터는 어떻게 모으나요?</h2>
      <p>각 플랫폼의 공개 API를 <b>${s ? Math.round(s.intervalSec / 60) : 5}분마다</b> 직접 조회해 지금 방송 중인 목록과 시청자 수를 기록합니다. 다른 통계 서비스의 데이터는 사용하지 않습니다.</p>
      <ul>
        <li><b>치지직</b>: 라이브 목록 API (인기순, 커서 페이지네이션), 채널 API(팔로워)</li>
        <li><b>SOOP</b>: 메인 방송 목록 API (시청자순), 방송국 API(애청자 수)</li>
        <li><b>트위치</b>: 공식 Helix API, 한국어 방송 (API 키가 설정된 경우)</li>
        <li><b>유튜브</b>: 공식 YouTube Data API. 한국 라이브를 1시간마다 검색해 찾고, 찾은 방송의 시청자 수는 매 주기 추적 (API 키가 설정된 경우, 뉴스 채널 제외)</li>
      </ul>
      <p>시청자 ${s ? num(s.minViewers) : 5}명 이상인 방송을 수집합니다. 팔로워 수는 방송 중인 상위 채널을 대상으로 하루 한 번 갱신합니다.</p>

      <h2>지표 설명</h2>
      <ul>
        <li><b>평균 시청자</b>: 방송 중 동시 시청자 수의 시간 가중 평균</li>
        <li><b>최고 시청자</b>: 수집 시점 중 가장 높았던 동시 시청자 수</li>
        <li><b>시청 시간</b>(뷰어십): 동시 시청자 수 × 방송 시간의 합. 예) 평균 1,000명이 2시간 방송하면 2,000시간</li>
        <li><b>방송 시간</b>: 수집기에 방송 중으로 잡힌 시간의 합</li>
        <li><b>평균 동시 시청자(카테고리/플랫폼)</b>: 기간 전체 시간 동안 해당 카테고리를 보고 있던 평균 인원</li>
        <li>날짜와 시간은 모두 <b>한국 시간(KST)</b> 기준입니다.</li>
      </ul>

      <h2>수집 상태</h2>
      ${s ? html`<div class="card"><div class="list">
        ${s.platforms.length ? s.platforms.map((p) => html`<div class="list-row"><span class="pdot pdot-${p.platform} ${p.lastError ? 'err' : ''}"></span>
          <span class="grow"><b>${platformName(p.platform)}</b> ${p.lastError ? html`<span class="muted small">· ${p.lastError}</span>` : ''}</span>
          <span class="muted small">마지막 성공 ${p.lastSuccessAt ? ago(p.lastSuccessAt) : '없음'}</span>
          <span class="num">${p.liveCount !== null ? `방송 ${num(p.liveCount)}개` : ''}</span></div>`) : html`<div class="muted">아직 수집 기록이 없습니다</div>`}
      </div>
      <p class="muted small">추적 중인 채널 ${num(s.channels)}개 · 방송 ${num(s.streams)}개 · 기록 시작 ${s.since || '-'}</p>
      <p class="muted small">지금 방송 수 기준 DB 쓰기량 추정: 월 약 <b>${num(s.estimatedMonthlyWrites)}</b>행
        ${s.estimatedMonthlyWrites > 10000000 ? html`<span class="delta up">(Turso 무료 한도 1,000만 행 초과 예상 · 수집 주기나 최소 시청자 수를 늘려 주세요)</span>` : ''}</p></div>` : ''}
    </div>`);
}
