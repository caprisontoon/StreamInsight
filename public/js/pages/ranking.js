import { api, csvUrl } from '../api.js';
import { $, empty, hours, href, html, liveDot, num, periodLabel, periodPicker, periodRange, platformFilter, rankChange, who } from '../ui.js';

export const SORT_OPTIONS = [
  { id: 'watch', label: '시청 시간', hint: '시청자 수 × 방송 시간의 합 (뷰어십)' },
  { id: 'avg', label: '평균 시청자', hint: '방송 중 평균 동시 시청자' },
  { id: 'peak', label: '최고 시청자', hint: '기간 중 최고 동시 시청자' },
  { id: 'air', label: '방송 시간', hint: '기간 중 총 방송 시간' },
  { id: 'followers', label: '팔로워', hint: '가장 최근 수집한 팔로워 수' },
];
const PAGE = 50;

export async function render(ctx) {
  const q = ctx.query;
  const range = periodRange(q);
  const sort = SORT_OPTIONS.some((s) => s.id === q.sort) ? q.sort : 'watch';
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const params = { from: range.from, to: range.to, platform: q.platform, category: q.category, sort, q: q.q, limit: PAGE, offset: (page - 1) * PAGE };
  const d = await api('rankings', params);
  if (!ctx.isCurrent()) return;

  const top = d.items[0];
  const metricOf = { watch: (r) => r.watchHours, avg: (r) => r.avgViewers, peak: (r) => r.peakViewers, air: (r) => r.airHours, followers: (r) => r.followers || 0 }[sort];
  const maxMetric = top ? Math.max(...d.items.map(metricOf), 1) : 1;
  const pages = Math.ceil(d.total / PAGE);

  const th = (id, label) => {
    const s = SORT_OPTIONS.find((o) => o.id === id);
    return html`<th class="sortable ${sort === id ? 'sorted' : ''}" data-sort="${id}" title="${s.hint}">${label}${sort === id ? ' ▼' : ''}</th>`;
  };
  const cell = (id, content, r) => (sort === id
    ? html`<td class="bar-cell"><span class="metric-main">${content}</span><div class="mini-bar"><span style="width:${Math.max(2, (metricOf(r) / maxMetric) * 100)}%"></span></div></td>`
    : html`<td>${content}</td>`);

  ctx.el.innerHTML = String(html`
    <div class="page-head">
      <div>
        <h1>스트리머 랭킹</h1>
        <p>${periodLabel(range)} · ${SORT_OPTIONS.find((s) => s.id === sort).label} 순 · 총 ${num(d.total)}명</p>
      </div>
      <a class="btn" href="${csvUrl('rankings', { ...params, limit: 500, offset: 0 })}" download>⬇ CSV 내려받기</a>
    </div>
    <div class="card">
      <div class="toolbar">${periodPicker(range)}</div>
      <div class="toolbar">
        ${platformFilter(q.platform)}
        <span class="spacer"></span>
        <select class="select" id="sort" aria-label="정렬 기준">
          ${SORT_OPTIONS.map((s) => html`<option value="${s.id}" ${s.id === sort ? 'selected' : ''}>${s.label} 순</option>`)}
        </select>
        <form id="rank-search" style="display:flex;gap:6px">
          <input class="input" name="q" type="search" placeholder="랭킹 내 검색" value="${q.q || ''}">
        </form>
      </div>
      ${q.category ? html`<div class="toolbar"><span class="chip active">카테고리: ${q.category} <a href="${href('/ranking', { ...q, category: undefined, page: undefined })}" aria-label="카테고리 필터 해제">✕</a></span></div>` : ''}
      ${d.items.length ? html`
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th class="rank">순위</th><th class="l">스트리머</th>
              ${th('avg', '평균 시청자')}${th('peak', '최고 시청자')}${th('watch', '시청 시간')}${th('air', '방송 시간')}${th('followers', '팔로워')}
              <th class="l">상태</th>
            </tr></thead>
            <tbody>
              ${d.items.map((r) => html`<tr>
                <td class="rank"><span class="rank-num">${r.rank}</span>${rankChange(r.rank, r.prevRank)}</td>
                <td class="l">${who(r, r.mainCategory ? html`${r.mainCategory} · ${r.days}일 방송` : '')}</td>
                ${cell('avg', num(r.avgViewers), r)}
                ${cell('peak', num(r.peakViewers), r)}
                ${cell('watch', hours(r.watchHours), r)}
                ${cell('air', hours(r.airHours), r)}
                ${cell('followers', r.followers ? num(r.followers) : '-', r)}
                <td class="l">${r.live ? html`<a href="#/stream/${r.live.streamId}">${liveDot(r.live.viewers)}</a>` : html`<span class="muted small">오프라인</span>`}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        ${pages > 1 ? html`<div class="pager">
          ${page > 1 ? html`<a class="btn btn-sm" href="${href('/ranking', { ...q, page: page - 1 })}">← 이전</a>` : ''}
          <span class="muted">${page} / ${pages}</span>
          ${page < pages ? html`<a class="btn btn-sm" href="${href('/ranking', { ...q, page: page + 1 })}">다음 →</a>` : ''}
        </div>` : ''}
        <p class="muted small" style="margin-top:12px">순위 변동은 직전 같은 길이 기간(${periodLabel(d.previous)})과 비교한 결과입니다.</p>
      ` : empty('해당 기간에 수집된 데이터가 없습니다', '기간이나 필터를 바꿔 보세요')}
    </div>
  `);

  $('#sort').addEventListener('change', (e) => ctx.setQuery({ sort: e.target.value, page: undefined }));
  ctx.el.querySelectorAll('th[data-sort]').forEach((t) => t.addEventListener('click', () => ctx.setQuery({ sort: t.dataset.sort, page: undefined })));
  $('#rank-search').addEventListener('submit', (e) => {
    e.preventDefault();
    ctx.setQuery({ q: new FormData(e.target).get('q').trim() || undefined, page: undefined });
  });
}
