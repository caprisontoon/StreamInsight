import { api } from '../api.js';
import { barChart, doughnutChart, lineChart, platformColor } from '../charts.js';
import { $, PLATFORM_IDS, empty, hours, html, num, pct, periodLabel, periodPicker, periodRange, platformName, shortDate } from '../ui.js';

export async function render(ctx) {
  const range = periodRange(ctx.query, '30d');
  const d = await api('platforms', { from: range.from, to: range.to });
  if (!ctx.isCurrent()) return;

  const totals = PLATFORM_IDS.map((p) => d.totals.find((t) => t.platform === p)).filter(Boolean);
  const totalWatch = totals.reduce((a, t) => a + t.watchHours, 0) || 1;
  const dates = [...new Set(d.daily.map((r) => r.date))].sort();
  const series = (key) => totals.map((t) => ({
    label: platformName(t.platform),
    color: platformColor(t.platform),
    data: dates.map((dt) => d.daily.find((r) => r.date === dt && r.platform === t.platform)?.[key] ?? null),
  }));

  ctx.el.innerHTML = String(html`
    <div class="page-head"><div><h1>플랫폼 분석</h1><p>${periodLabel(range)} · 치지직 · SOOP · 트위치 · 유튜브 비교</p></div></div>
    <div class="toolbar">${periodPicker(range)}</div>
    ${totals.length ? html`
      <div class="grid grid-2">
        ${totals.map((t) => html`<div class="kpi platform" style="--pc:${platformColor(t.platform)}">
          <div class="kpi-label"><span class="pdot pdot-${t.platform}"></span>${platformName(t.platform)} <span class="muted">· 시청 점유율 ${pct(t.watchHours / totalWatch)}</span></div>
          <div class="kpi-value">${hours(t.watchHours)}</div>
          <div class="kpi-sub">평균 동시 ${num(t.avgConcurrent)}명 · 최고 ${num(t.peakConcurrent)}명 · 방송 채널 ${num(t.channels)}개 · 방송 ${hours(t.airHours)}</div>
        </div>`)}
      </div>
      <div class="grid grid-main section">
        <div class="card"><div class="card-head"><h2>일별 평균 동시 시청자</h2></div><div class="chart-box"><canvas id="p-avg"></canvas></div></div>
        <div class="card"><div class="card-head"><h2>시청 시간 점유율</h2></div><div class="chart-box"><canvas id="p-share"></canvas></div></div>
      </div>
      <div class="grid grid-2 section">
        <div class="card"><div class="card-head"><h2>일별 최고 동시 시청자</h2></div><div class="chart-box"><canvas id="p-peak"></canvas></div></div>
        <div class="card"><div class="card-head"><h2>일별 방송 채널 수</h2></div><div class="chart-box"><canvas id="p-ch"></canvas></div></div>
      </div>
      <div class="card section"><div class="card-head"><h2>시간대별 평균 시청자 (KST)</h2><span class="muted small">언제 시청자가 가장 많은지</span></div><div class="chart-box"><canvas id="p-hour"></canvas></div></div>
    ` : empty('해당 기간에 수집된 데이터가 없습니다')}
  `);
  if (!totals.length) return;

  const labels = dates.map(shortDate);
  lineChart($('#p-avg'), { labels, datasets: series('avgConcurrent') });
  lineChart($('#p-peak'), { labels, datasets: series('peakConcurrent') });
  barChart($('#p-ch'), { labels, datasets: series('channels') });
  doughnutChart($('#p-share'), {
    labels: totals.map((t) => platformName(t.platform)),
    data: totals.map((t) => Math.round(t.watchHours)),
    colors: totals.map((t) => platformColor(t.platform)),
    format: (v) => hours(v),
  });
  const hrs = [...Array(24).keys()];
  lineChart($('#p-hour'), {
    labels: hrs.map((h) => `${h}시`),
    datasets: totals.map((t) => ({
      label: platformName(t.platform),
      color: platformColor(t.platform),
      data: hrs.map((h) => d.hourly.find((r) => r.hour === h && r.platform === t.platform)?.viewers ?? null),
    })),
  });
}
