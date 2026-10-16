import { api } from '../api.js';
import { destroyCharts, doughnutChart, lineChart, platformColor } from '../charts.js';
import { $, PLATFORMS, PLATFORM_IDS, delta, empty, hours, href, html, kpi, liveCard, liveDot, num, pct, platformName, rankChange, timeOnly, todayKst, who } from '../ui.js';

export async function render(ctx) {
  const draw = async (fresh) => {
    const [o, rank] = await Promise.all([
      api('overview', {}, { fresh }),
      api('rankings', { from: todayKst(), to: todayKst(), sort: 'watch', limit: 10 }, { fresh }),
    ]);
    if (!ctx.isCurrent()) return;
    destroyCharts();
    const byP = Object.fromEntries(o.platforms.map((p) => [p.platform, p]));
    const total = o.platforms.reduce((a, p) => a + p.viewers, 0);
    const totalDayAgo = o.platforms.every((p) => p.viewersDayAgo) ? o.platforms.reduce((a, p) => a + p.viewersDayAgo, 0) : null;
    const liveChannels = o.platforms.reduce((a, p) => a + p.channels, 0);

    ctx.el.innerHTML = String(html`
      <div class="page-head">
        <div>
          <h1>지금 방송 현황</h1>
          <p>치지직 · SOOP · 트위치 · 유튜브 한국어 방송의 실시간 시청자 통계 <span class="free-badge">모든 기능 무료</span></p>
        </div>
      </div>

      <div class="kpis">
        ${kpi('전체 시청자', num(total), html`${delta(total, totalDayAgo)} ${totalDayAgo ? '어제 같은 시각 대비' : ''}`)}
        ${PLATFORM_IDS.map((p) => {
          const d = byP[p];
          return html`<div class="kpi platform" style="--pc:${platformColor(p)}">
            <div class="kpi-label"><span class="pdot pdot-${p}"></span>${platformName(p)}</div>
            <div class="kpi-value">${d ? num(d.viewers) : '-'}</div>
            <div class="kpi-sub">${d ? html`방송 ${num(d.channels)}개 · ${delta(d.viewers, d.viewersDayAgo)}` : '수집 대기 중'}</div>
          </div>`;
        })}
        ${kpi('방송 중 채널', num(liveChannels), `오늘 방송한 채널 ${num(o.today.channels)}개`)}
      </div>

      <div class="grid grid-main section">
        <div class="card">
          <div class="card-head"><h2>최근 24시간 시청자 추이</h2><a class="more" href="#/platforms">플랫폼 분석 →</a></div>
          <div class="chart-box"><canvas id="trend"></canvas></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>플랫폼 점유율</h2><span class="muted small">현재 시청자 기준</span></div>
          ${total ? html`
            <div class="chart-box short"><canvas id="share"></canvas></div>
            <div class="list" style="margin-top:12px">
              ${PLATFORM_IDS.filter((p) => byP[p]).map((p) => html`
                <div class="list-row"><span class="pdot pdot-${p}"></span><span class="grow">${platformName(p)}</span>
                <span class="num">${num(byP[p].viewers)}</span><b class="num" style="width:56px;text-align:right">${pct(byP[p].viewers / total)}</b></div>`)}
            </div>` : empty('수집된 데이터가 없습니다')}
        </div>
      </div>

      <div class="card section">
        <div class="card-head"><h2>지금 인기 방송</h2><a class="more" href="#/live">전체 보기 →</a></div>
        ${o.top.length ? html`<div class="live-grid">${o.top.map(liveCard)}</div>` : empty('지금 방송 중인 채널이 없습니다')}
      </div>

      <div class="grid grid-2 section">
        <div class="card">
          <div class="card-head"><h2>지금 인기 카테고리</h2><a class="more" href="#/categories">카테고리 분석 →</a></div>
          ${o.categories.length ? html`<div class="list">${o.categories.map((c, i) => html`
            <a class="list-row" href="${href('/live', { category: c.category })}">
              <span class="idx">${i + 1}</span>
              <span class="grow"><b>${c.category}</b> <span class="muted small">방송 ${c.channels}개</span>
                <div class="mini-bar"><span style="width:${Math.max(2, (c.viewers / o.categories[0].viewers) * 100)}%"></span></div>
              </span>
              <span class="num">${num(c.viewers)}명</span>
            </a>`)}</div>` : empty()}
        </div>
        <div class="card">
          <div class="card-head"><h2>오늘의 스트리머 TOP 10</h2><a class="more" href="${href('/ranking', { period: 'today' })}">랭킹 전체 →</a></div>
          ${rank.items.length ? html`<div class="list">${rank.items.map((r) => html`
            <div class="list-row">
              <span class="idx">${r.rank}</span>
              <span class="grow">${who(r, html`평균 ${num(r.avgViewers)}명 · ${hours(r.airHours)} 방송`)}</span>
              ${r.live ? liveDot(r.live.viewers) : rankChange(r.rank, r.prevRank)}
            </div>`)}</div>` : empty('오늘 수집된 방송이 없습니다')}
        </div>
      </div>
    `);

    // 24시간 추이 차트
    const tsList = [...new Set(o.trend.map((t) => t.ts))].sort((a, b) => a - b);
    const idx = new Map(tsList.map((t, i) => [t, i]));
    const series = PLATFORM_IDS.map((p) => {
      const data = new Array(tsList.length).fill(null);
      for (const t of o.trend) if (t.platform === p) data[idx.get(t.ts)] = t.viewers;
      return { label: PLATFORMS[p].name, data, color: platformColor(p) };
    }).filter((s) => s.data.some((v) => v !== null));
    if (series.length) {
      lineChart($('#trend'), { labels: tsList.map(timeOnly), datasets: series, area: true });
    }
    if (total) {
      const ps = PLATFORM_IDS.filter((p) => byP[p]);
      doughnutChart($('#share'), { labels: ps.map(platformName), data: ps.map((p) => byP[p].viewers), colors: ps.map(platformColor) });
    }
  };

  await draw(false);
  const timer = setInterval(() => draw(true).catch(() => {}), 60000);
  return () => clearInterval(timer);
}
