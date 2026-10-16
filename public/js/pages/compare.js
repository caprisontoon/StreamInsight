import { api } from '../api.js';
import { barChart, lineChart, seriesColor } from '../charts.js';
import { $, DOW_NAMES, avatar, channelHref, compareList, empty, hours, href, html, liveDot, num, periodLabel, periodPicker, periodRange, platformBadge, shortDate, toast } from '../ui.js';

const METRICS = [
  { id: 'avgViewers', label: '평균 시청자', fmt: num },
  { id: 'peakViewers', label: '최고 시청자', fmt: num },
  { id: 'watchHours', label: '시청 시간', fmt: hours },
  { id: 'airHours', label: '방송 시간', fmt: hours },
];

export async function render(ctx) {
  const q = ctx.query;
  // 공유 링크(?ids=...)로 들어오면 비교 목록을 그 값으로 맞춘다
  if (q.ids) {
    const fromUrl = q.ids.split(',').filter(Boolean).map((s) => {
      const [platform, ...rest] = s.split(':');
      return { platform, channelId: rest.join(':') };
    });
    compareList.set(fromUrl);
  }
  const list = compareList.all();
  const range = periodRange(q, '30d');
  const metric = METRICS.find((m) => m.id === q.metric) || METRICS[0];

  const d = list.length
    ? await api('compare', { ids: list.map((c) => `${c.platform}:${c.channelId}`).join(','), from: range.from, to: range.to })
    : { items: [] };
  if (!ctx.isCurrent()) return;

  const dates = [...new Set(d.items.flatMap((i) => i.daily.map((r) => r.date)))].sort();

  ctx.el.innerHTML = String(html`
    <div class="page-head">
      <div><h1>스트리머 비교</h1><p>최대 ${compareList.MAX}명까지 나란히 비교 · ${periodLabel(range)}</p></div>
      ${d.items.length ? html`<button class="btn" id="share">🔗 비교 링크 복사</button>` : ''}
    </div>
    <div class="card">
      <div class="toolbar" style="margin-bottom:12px">
        ${d.items.map((i, idx) => html`<span class="compare-chip"><span class="swatch" style="background:${seriesColor(idx)}"></span>
          ${avatar(i.channel.name, i.channel.image, i.channel.platform, 26)}<a href="${channelHref(i.channel.platform, i.channel.channelId)}">${i.channel.name}</a>
          <button data-remove="${i.channel.platform}:${i.channel.channelId}" aria-label="비교에서 제거">✕</button></span>`)}
        ${list.length < compareList.MAX ? html`<div class="search" style="max-width:280px;margin:0">
          <input class="input" id="cmp-search" type="search" placeholder="+ 스트리머 추가" autocomplete="off" style="width:100%">
          <div id="cmp-results" class="search-results" hidden></div>
        </div>` : ''}
      </div>
      <div class="toolbar" style="margin-bottom:0">${periodPicker(range)}</div>
    </div>

    ${d.items.length ? html`
      <div class="card section">
        <div class="card-head"><h2>일별 ${metric.label}</h2>
          <div class="chips">${METRICS.map((m) => html`<a class="chip ${m.id === metric.id ? 'active' : ''}" href="${href('/compare', { ...q, ids: undefined, metric: m.id })}">${m.label}</a>`)}</div>
        </div>
        <div class="chart-box tall"><canvas id="cmp-daily"></canvas></div>
      </div>
      <div class="card section">
        <div class="card-head"><h2>기간 요약</h2></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th class="l">스트리머</th><th>평균 시청자</th><th>최고 시청자</th><th>시청 시간</th><th>방송 시간</th><th>방송 횟수</th><th>팔로워</th><th class="l">주 카테고리</th><th class="l">주 방송 요일</th></tr></thead>
          <tbody>${d.items.map((i, idx) => html`<tr>
            <td class="l"><a class="who" href="${channelHref(i.channel.platform, i.channel.channelId)}"><span class="swatch" style="background:${seriesColor(idx)}"></span>
              ${avatar(i.channel.name, i.channel.image, i.channel.platform, 32)}<span class="who-text"><span class="who-name"><span class="n">${i.channel.name}</span>${platformBadge(i.channel.platform, true)}</span></span></a></td>
            <td><b>${num(i.summary.avgViewers)}</b></td><td>${num(i.summary.peakViewers)}</td><td>${hours(i.summary.watchHours)}</td><td>${hours(i.summary.airHours)}</td>
            <td>${num(i.summary.streams)}회</td><td>${i.channel.followers ? num(i.channel.followers) : '-'}</td>
            <td class="l">${i.categories[0] ? html`<span class="tag">${i.categories[0].category}</span>` : '-'}</td>
            <td class="l">${topDays(i.heatmap)} ${i.live ? liveDot(i.live.viewers) : ''}</td>
          </tr>`)}</tbody>
        </table></div>
      </div>
      <div class="card section">
        <div class="card-head"><h2>지표별 비교</h2></div>
        <div class="grid grid-2">${METRICS.map((m) => html`<div><div class="muted small" style="font-weight:600;margin-bottom:6px">${m.label}</div><div class="chart-box short"><canvas id="cmp-${m.id}"></canvas></div></div>`)}</div>
      </div>
    ` : html`<div class="card section">${empty('비교할 스트리머를 추가하세요', '위 검색창이나 스트리머 페이지의 "비교에 추가" 버튼을 사용하세요')}</div>`}
  `);

  ctx.el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    const [platform, ...rest] = b.dataset.remove.split(':');
    compareList.remove(platform, rest.join(':'));
    reload(ctx, q);
  }));

  $('#share')?.addEventListener('click', async () => {
    const ids = list.map((c) => `${c.platform}:${c.channelId}`).join(',');
    const url = `${location.origin}/${href('/compare', { ...q, ids, period: range.id, from: range.id === 'custom' ? range.from : undefined, to: range.id === 'custom' ? range.to : undefined })}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('비교 링크를 복사했어요');
    } catch {
      prompt('아래 링크를 복사하세요', url);
    }
  });

  setupSearch(ctx, q);

  if (!d.items.length) return;
  lineChart($('#cmp-daily'), {
    labels: dates.map(shortDate),
    yFormat: metric.id.endsWith('Hours') ? (v) => hours(v) : undefined,
    tooltipFormat: metric.fmt,
    datasets: d.items.map((i, idx) => ({
      label: i.channel.name,
      color: seriesColor(idx),
      data: dates.map((dt) => i.daily.find((r) => r.date === dt)?.[metric.id] ?? null),
      extra: { spanGaps: false, pointRadius: 2 },
    })),
  });
  for (const m of METRICS) {
    barChart($(`#cmp-${m.id}`), {
      labels: d.items.map((i) => i.channel.name),
      datasets: [{ label: m.label, data: d.items.map((i) => i.summary[m.id]), colors: d.items.map((_, idx) => seriesColor(idx)) }],
      legend: false,
      yFormat: m.id.endsWith('Hours') ? (v) => hours(v) : undefined,
      tooltipFormat: m.fmt,
    });
  }
}

function topDays(heat) {
  const byDow = new Map();
  for (const h of heat) byDow.set(h.dow, (byDow.get(h.dow) || 0) + h.airHours);
  return [...byDow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => DOW_NAMES[d]).join('·') || '-';
}

function setupSearch(ctx, q) {
  const input = $('#cmp-search');
  const box = $('#cmp-results');
  if (!input) return;
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const s = input.value.trim();
    if (!s) {
      box.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      const r = await api('search', { q: s, limit: 8 }).catch(() => ({ items: [] }));
      box.innerHTML = String(r.items.length ? html`${r.items.map((c) => html`
        <a class="search-item" href="#" data-add='${JSON.stringify({ platform: c.platform, channelId: c.channelId, name: c.name, image: c.image })}'>
          ${avatar(c.name, c.image, c.platform, 28)}<span class="search-name">${c.name}</span>${platformBadge(c.platform, true)}
        </a>`)}` : html`<div class="search-empty">검색 결과가 없습니다</div>`);
      box.hidden = false;
      box.querySelectorAll('[data-add]').forEach((a) => a.addEventListener('click', (e) => {
        e.preventDefault();
        compareList.add(JSON.parse(a.dataset.add));
        reload(ctx, q);
      }));
    }, 180);
  });
}

function reload(ctx, q) {
  const h = href('/compare', { ...q, ids: undefined });
  if (location.hash === h) ctx.refresh();
  else ctx.navigate(h);
}
