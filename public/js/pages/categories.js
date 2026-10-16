import { api, csvUrl } from '../api.js';
import { barChart, platformColor } from '../charts.js';
import { $, PLATFORM_IDS, empty, hours, href, html, num, pct, periodLabel, periodPicker, periodRange, platformFilter, platformName } from '../ui.js';

export async function render(ctx) {
  const q = ctx.query;
  const range = periodRange(q);
  const params = { from: range.from, to: range.to, platform: q.platform, q: q.q, limit: 200 };
  const d = await api('categories', params);
  if (!ctx.isCurrent()) return;
  const maxWatch = d.items[0]?.watchHours || 1;
  const linkQ = { period: q.period, from: q.from, to: q.to, platform: q.platform };

  ctx.el.innerHTML = String(html`
    <div class="page-head">
      <div><h1>카테고리 분석</h1><p>${periodLabel(range)} · 시청 시간 기준 · ${num(d.items.length)}개 카테고리</p></div>
      <a class="btn" href="${csvUrl('categories', params)}" download>⬇ CSV 내려받기</a>
    </div>
    <div class="card">
      <div class="toolbar">${periodPicker(range)}</div>
      <div class="toolbar">
        ${platformFilter(q.platform)}
        <span class="spacer"></span>
        <form id="cat-search"><input class="input" name="q" type="search" placeholder="카테고리 검색" value="${q.q || ''}"></form>
      </div>
      ${d.items.length ? html`
        <div class="chart-box tall"><canvas id="cat-chart"></canvas></div>
        <div class="table-wrap section">
          <table class="table">
            <thead><tr>
              <th class="rank">순위</th><th class="l">카테고리</th><th title="시청자 수 × 방송 시간의 합">시청 시간</th><th>점유율</th>
              <th title="기간 전체를 통틀어 이 카테고리를 보고 있던 평균 시청자 수">평균 동시 시청자</th>
              <th title="이 카테고리 방송 1개당 평균 시청자">방송당 평균</th><th>최고 시청자</th><th>방송 채널</th><th>방송 시간</th>
              <th class="l">플랫폼 비중</th>
            </tr></thead>
            <tbody>${d.items.map((c) => {
              const total = PLATFORM_IDS.reduce((a, p) => a + (c.byPlatform[p] || 0), 0) || 1;
              return html`<tr>
                <td class="rank"><span class="rank-num">${c.rank}</span></td>
                <td class="l"><a href="${href(`/category/${encodeURIComponent(c.category)}`, linkQ)}"><b>${c.category}</b></a></td>
                <td class="bar-cell"><span class="metric-main">${hours(c.watchHours)}</span><div class="mini-bar"><span style="width:${Math.max(2, (c.watchHours / maxWatch) * 100)}%"></span></div></td>
                <td>${pct(c.share)}</td>
                <td>${num(c.avgConcurrent)}</td>
                <td>${num(c.avgPerStream)}</td>
                <td>${num(c.peak)}</td>
                <td>${num(c.channels)}</td>
                <td>${hours(c.airHours)}</td>
                <td class="l" style="min-width:120px"><div class="share-bar" title="${PLATFORM_IDS.map((p) => `${platformName(p)} ${pct((c.byPlatform[p] || 0) / total)}`).join(' / ')}">
                  ${PLATFORM_IDS.map((p) => html`<span style="width:${((c.byPlatform[p] || 0) / total) * 100}%;background:${platformColor(p)}"></span>`)}
                </div></td>
              </tr>`;
            })}</tbody>
          </table>
        </div>` : empty('해당 기간에 수집된 데이터가 없습니다')}
    </div>
  `);

  $('#cat-search').addEventListener('submit', (e) => {
    e.preventDefault();
    ctx.setQuery({ q: new FormData(e.target).get('q').trim() || undefined });
  });

  if (d.items.length) {
    const top = d.items.slice(0, 15);
    const chart = barChart($('#cat-chart'), {
      labels: top.map((c) => c.category),
      horizontal: true,
      stacked: true,
      yFormat: (v) => hours(v),
      tooltipFormat: (v) => hours(v),
      datasets: PLATFORM_IDS.filter((p) => !q.platform || q.platform === p).map((p) => ({
        label: platformName(p), data: top.map((c) => c.byPlatform[p] || 0), color: platformColor(p),
      })),
    });
    chart.options.onClick = (evt, els) => {
      if (els[0]) ctx.navigate(href(`/category/${encodeURIComponent(top[els[0].index].category)}`, linkQ));
    };
  }
}
