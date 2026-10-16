import { api } from '../api.js';
import { lineChart, platformColor } from '../charts.js';
import { $, PLATFORM_IDS, empty, hours, href, html, kpi, liveDot, num, periodLabel, periodPicker, periodRange, platformFilter, platformName, shortDate, who } from '../ui.js';

export async function render(ctx) {
  const [name] = ctx.params;
  const q = ctx.query;
  const range = periodRange(q);
  const d = await api(`categories/${encodeURIComponent(name)}`, { from: range.from, to: range.to, platform: q.platform, limit: 30 });
  if (!ctx.isCurrent()) return;

  const dates = [...new Set(d.daily.map((r) => r.date))].sort();
  const watch = d.daily.reduce((a, r) => a + r.watchHours, 0);
  const air = d.daily.reduce((a, r) => a + r.airHours, 0);

  ctx.el.innerHTML = String(html`
    <div class="page-head">
      <div><p><a href="${href('/categories', { period: q.period, from: q.from, to: q.to })}">← 카테고리 분석</a></p><h1>${name}</h1><p>${periodLabel(range)}</p></div>
      <a class="btn" href="${href('/ranking', { period: q.period, from: q.from, to: q.to, category: name })}">이 카테고리 랭킹 보기</a>
    </div>
    <div class="toolbar">${periodPicker(range)}</div>
    <div class="kpis">
      ${kpi('총 시청 시간', hours(watch))}
      ${kpi('총 방송 시간', hours(air))}
      ${kpi('방송당 평균 시청자', air ? num(watch / air) : '-')}
      ${kpi('방송한 스트리머', `${num(d.channels)}명`)}
    </div>
    <div class="card section">
      <div class="card-head"><h2>일별 시청 시간</h2></div>
      ${dates.length ? html`<div class="chart-box"><canvas id="cat-daily"></canvas></div>` : empty()}
    </div>
    <div class="card section">
      <div class="card-head"><h2>이 카테고리의 인기 스트리머</h2>${platformFilter(q.platform)}</div>
      ${d.top.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th class="rank">순위</th><th class="l">스트리머</th><th>평균 시청자</th><th>최고 시청자</th><th>시청 시간</th><th>방송 시간</th><th class="l">상태</th></tr></thead>
        <tbody>${d.top.map((r) => html`<tr>
          <td class="rank"><span class="rank-num">${r.rank}</span></td>
          <td class="l">${who(r)}</td>
          <td><b>${num(r.avgViewers)}</b></td><td>${num(r.peakViewers)}</td><td>${hours(r.watchHours)}</td><td>${hours(r.airHours)}</td>
          <td class="l">${r.live ? liveDot(r.live.viewers) : html`<span class="muted small">오프라인</span>`}</td>
        </tr>`)}</tbody></table></div>` : empty()}
    </div>
  `);

  if (dates.length) {
    const ps = PLATFORM_IDS.filter((p) => d.daily.some((r) => r.platform === p));
    lineChart($('#cat-daily'), {
      labels: dates.map(shortDate),
      area: true,
      stacked: true,
      yFormat: (v) => hours(v),
      tooltipFormat: (v) => hours(v),
      datasets: ps.map((p) => ({
        label: platformName(p),
        color: platformColor(p),
        data: dates.map((dt) => d.daily.find((r) => r.date === dt && r.platform === p)?.watchHours ?? 0),
      })),
    });
  }
}
