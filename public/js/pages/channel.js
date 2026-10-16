import { api, csvUrl } from '../api.js';
import { alpha, barChart, doughnutChart, lineChart, platformColor, seriesColor } from '../charts.js';
import {
  $, DOW_NAMES, avatar, channelUrl, compareList, dateTime, duration, empty, favorites, hours, href, html, kpi, liveDot,
  num, periodLabel, periodPicker, periodRange, platformBadge, platformName, shortDate, thumb, toast,
} from '../ui.js';

export async function render(ctx) {
  const [platform, channelId] = ctx.params;
  const range = periodRange(ctx.query, '30d');
  const d = await api(`channels/${platform}/${encodeURIComponent(channelId)}`, { from: range.from, to: range.to });
  if (!ctx.isCurrent()) return;
  const ch = d.channel;
  const s = d.summary;
  const color = platformColor(platform);

  const fol = d.followers;
  const folChange = fol.length >= 2 ? fol.at(-1).followers - fol[0].followers : null;

  ctx.el.innerHTML = String(html`
    <div class="card">
      <div class="channel-head">
        ${avatar(ch.name, ch.image, platform, 76)}
        <div class="info">
          <h1>${ch.name || ch.channelId} ${platformBadge(platform)} ${d.live ? liveDot(d.live.viewers) : ''}</h1>
          <div class="muted">
            ${ch.followers ? html`팔로워 <b style="color:var(--text)">${num(ch.followers)}</b>명 ${folChange ? html`<span class="delta ${folChange > 0 ? 'up' : 'down'}">(${folChange > 0 ? '+' : ''}${num(folChange)})</span>` : ''} · ` : ''}
            ${d.live ? '지금 방송 중' : `마지막 방송 ${ch.lastLiveAt ? dateTime(ch.lastLiveAt) : '-'}`}
            · 수집 시작 ${ch.firstSeenAt ? dateTime(ch.firstSeenAt).split(' ')[0] : '-'}
          </div>
        </div>
        <div class="actions">
          <button class="btn ${favorites.has(platform, ch.channelId) ? 'on' : ''}" id="fav">${favorites.has(platform, ch.channelId) ? '★ 즐겨찾기됨' : '☆ 즐겨찾기'}</button>
          <button class="btn" id="cmp">⇄ 비교에 추가</button>
          <a class="btn" href="${channelUrl(platform, ch.channelId, ch.login)}" target="_blank" rel="noopener">${platformName(platform)}에서 보기 ↗</a>
        </div>
      </div>
      ${d.live ? html`
        <a class="live-now" href="#/stream/${d.live.streamId}">
          <div class="live-thumb">${thumb(d.live.thumbnail)}</div>
          <div style="min-width:0;flex:1">
            <div style="font-weight:700">${d.live.title || '(제목 없음)'}</div>
            <div class="muted small">${d.live.category || ''} · ${duration(Math.floor(Date.now() / 1000) - d.live.startedAt)} 째 방송 중 · 현재 ${num(d.live.viewers)}명 · 최고 ${num(d.live.peakViewers)}명</div>
          </div>
          <span class="btn btn-sm">실시간 그래프 →</span>
        </a>` : ''}
    </div>

    <div class="toolbar section">${periodPicker(range)}<span class="spacer"></span>
      <a class="btn btn-sm" href="${csvUrl(`channels/${platform}/${encodeURIComponent(channelId)}`, { from: range.from, to: range.to })}" download>⬇ 방송 기록 CSV</a>
    </div>

    <div class="kpis">
      ${kpi('평균 시청자', num(s.avgViewers), periodLabel(range))}
      ${kpi('최고 시청자', num(s.peakViewers))}
      ${kpi('시청 시간', hours(s.watchHours), '', '시청자 수 × 방송 시간의 합')}
      ${kpi('방송 시간', hours(s.airHours), `${s.days}일 · 방송 ${num(s.streams)}회`)}
      ${kpi(`${platformName(platform)} 순위`, s.rank ? `${num(s.rank)}위` : '-', s.rankTotal ? `시청 시간 기준 / ${num(s.rankTotal)}명` : '')}
    </div>

    ${d.daily.length ? html`
      <div class="grid grid-main section">
        <div class="card"><div class="card-head"><h2>일별 시청자</h2></div><div class="chart-box"><canvas id="c-daily"></canvas></div></div>
        <div class="card"><div class="card-head"><h2>카테고리 비중</h2><span class="muted small">방송 시간 기준</span></div>
          <div class="chart-box short"><canvas id="c-cat"></canvas></div>
          <div class="list" style="margin-top:10px">${d.categories.slice(0, 6).map((c, i) => html`
            <a class="list-row" href="${href(`/category/${encodeURIComponent(c.category)}`, { period: ctx.query.period, from: ctx.query.from, to: ctx.query.to })}">
              <span class="swatch" style="background:${seriesColor(i)}"></span><span class="grow">${c.category}</span>
              <span class="muted small">${hours(c.airHours)}</span><b class="num">${num(c.avgViewers)}명</b>
            </a>`)}</div>
        </div>
      </div>
      <div class="grid grid-2 section">
        <div class="card"><div class="card-head"><h2>일별 방송 시간</h2></div><div class="chart-box short"><canvas id="c-air"></canvas></div></div>
        <div class="card"><div class="card-head"><h2>팔로워 추이</h2></div>
          ${fol.length >= 2 ? html`<div class="chart-box short"><canvas id="c-fol"></canvas></div>` : empty('팔로워 기록이 아직 부족합니다', '방송 중일 때 하루 한 번 수집합니다')}
        </div>
      </div>
      <div class="card section">
        <div class="card-head"><h2>방송 시간대 패턴</h2><span class="muted small">요일 × 시간 (KST), 진할수록 자주 방송</span></div>
        ${heatmap(d.heatmap, color)}
      </div>
    ` : html`<div class="card section">${empty('선택한 기간에 방송 기록이 없습니다', '기간을 넓혀 보세요')}</div>`}

    <div class="card section">
      <div class="card-head"><h2>방송 기록</h2><span class="muted small">${num(d.streams.length)}개</span></div>
      ${d.streams.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th class="l">시작</th><th class="l">제목</th><th class="l">카테고리</th><th>방송 시간</th><th>평균 시청자</th><th>최고 시청자</th><th>시청 시간</th></tr></thead>
        <tbody>${d.streams.map((st) => html`<tr>
          <td class="l"><a href="#/stream/${st.id}">${dateTime(st.startedAt)}</a> ${st.live ? liveDot() : ''}</td>
          <td class="l" style="max-width:340px;overflow:hidden;text-overflow:ellipsis"><a href="#/stream/${st.id}" title="${st.title}">${st.title || '(제목 없음)'}</a></td>
          <td class="l"><span class="tag">${st.category}</span></td>
          <td>${duration(st.airHours * 3600)}</td>
          <td><b>${num(st.avgViewers)}</b></td>
          <td>${num(st.peakViewers)}</td>
          <td>${hours(st.watchHours)}</td>
        </tr>`)}</tbody></table></div>` : empty()}
    </div>
  `);

  $('#fav').addEventListener('click', (e) => {
    const on = favorites.toggle({ platform, channelId: ch.channelId, name: ch.name, image: ch.image });
    e.currentTarget.classList.toggle('on', on);
    e.currentTarget.textContent = on ? '★ 즐겨찾기됨' : '☆ 즐겨찾기';
    toast(on ? '즐겨찾기에 추가했어요' : '즐겨찾기에서 뺐어요');
  });
  $('#cmp').addEventListener('click', () => {
    compareList.add({ platform, channelId: ch.channelId, name: ch.name, image: ch.image });
    toast(`비교 목록에 추가했어요 (${compareList.all().length}/${compareList.MAX})`);
    ctx.navigate(href('/compare', { period: ctx.query.period, from: ctx.query.from, to: ctx.query.to }));
  });

  if (!d.daily.length) return;
  const labels = d.daily.map((r) => shortDate(r.date));
  lineChart($('#c-daily'), {
    labels,
    datasets: [
      { label: '평균 시청자', data: d.daily.map((r) => r.avgViewers), color },
      { label: '최고 시청자', data: d.daily.map((r) => r.peakViewers), color: '#f59e0b', extra: { borderDash: [5, 4], borderWidth: 1.5 } },
    ],
  });
  barChart($('#c-air'), { labels, datasets: [{ label: '방송 시간', data: d.daily.map((r) => Math.round(r.airHours * 10) / 10), color }], yFormat: (v) => `${v}h`, tooltipFormat: (v) => hours(v) });
  doughnutChart($('#c-cat'), {
    labels: d.categories.map((c) => c.category),
    data: d.categories.map((c) => Math.round(c.airHours * 10) / 10),
    colors: d.categories.map((c, i) => seriesColor(i)),
    format: (v) => hours(v),
  });
  if (fol.length >= 2) {
    const fc = lineChart($('#c-fol'), { labels: fol.map((f) => shortDate(f.date)), datasets: [{ label: '팔로워', data: fol.map((f) => f.followers), color }], area: true });
    fc.options.scales.y.beginAtZero = false;
    fc.update();
  }
}

function heatmap(cells, color) {
  const map = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));
  const max = Math.max(0.01, ...cells.map((c) => c.airHours));
  const order = [1, 2, 3, 4, 5, 6, 0];
  return html`
    <div class="heatmap">
      <span></span>${[...Array(24).keys()].map((h) => html`<span class="hl">${h % 3 === 0 ? h : ''}</span>`)}
      ${order.map((dow) => html`<span class="dl">${DOW_NAMES[dow]}</span>${[...Array(24).keys()].map((h) => {
        const c = map.get(`${dow}:${h}`);
        const a = c ? 0.15 + (c.airHours / max) * 0.85 : 0;
        return html`<span class="cell" style="${c ? `background:${alpha(color, a)}` : ''}" title="${DOW_NAMES[dow]}요일 ${h}시${c ? ` · 방송 ${hours(c.airHours)} · 평균 ${num(c.avgViewers)}명` : ' · 방송 없음'}"></span>`;
      })}`)}
    </div>
    <div class="heat-legend">적음 ${[0.15, 0.4, 0.65, 1].map((a) => html`<span class="cell" style="background:${alpha(color, a)}"></span>`)} 많음</div>`;
}


