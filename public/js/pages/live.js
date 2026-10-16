import { api } from '../api.js';
import { $, empty, html, liveCard, num, platformFilter } from '../ui.js';

const PAGE = 48;

export async function render(ctx) {
  const q = ctx.query;
  let limit = PAGE;

  const draw = async (fresh) => {
    const d = await api('live', { platform: q.platform, category: q.category, q: q.q, limit }, { fresh });
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = String(html`
      <div class="page-head">
        <div>
          <h1>실시간 방송</h1>
          <p>지금 방송 중 <b>${num(d.total)}</b>개 · 시청자 <b>${num(d.totalViewers)}</b>명 <span class="muted small">(1분마다 자동 갱신)</span></p>
        </div>
      </div>
      <div class="toolbar">
        ${platformFilter(q.platform)}
        <span class="spacer"></span>
        <form id="live-search" style="display:flex;gap:6px">
          <input class="input" name="q" type="search" placeholder="방송 제목·스트리머 검색" value="${q.q || ''}">
          <button class="btn" type="submit">검색</button>
        </form>
      </div>
      <div class="chips" style="margin-bottom:16px">
        <a class="chip ${!q.category ? 'active' : ''}" href="${link(q, { category: undefined })}">전체 카테고리</a>
        ${q.category && !d.categories.some((c) => c.category === q.category) ? html`<a class="chip active" href="${link(q, { category: q.category })}">${q.category}</a>` : ''}
        ${d.categories.map((c) => html`<a class="chip ${q.category === c.category ? 'active' : ''}" href="${link(q, { category: c.category })}">${c.category} <span class="muted small">${num(c.viewers)}</span></a>`)}
      </div>
      ${d.items.length ? html`<div class="live-grid">${d.items.map(liveCard)}</div>` : empty('조건에 맞는 방송이 없습니다')}
      ${d.total > d.items.length ? html`<div class="pager"><button class="btn" id="more">더 보기 (${num(d.items.length)} / ${num(d.total)})</button></div>` : ''}
    `);
    $('#live-search').addEventListener('submit', (e) => {
      e.preventDefault();
      ctx.setQuery({ q: new FormData(e.target).get('q').trim() || undefined });
    });
    $('#more')?.addEventListener('click', () => {
      limit += PAGE;
      draw(false);
    });
  };

  await draw(false);
  const timer = setInterval(() => {
    const y = window.scrollY;
    draw(true).then(() => window.scrollTo(0, y)).catch(() => {});
  }, 60000);
  return () => clearInterval(timer);
}

function link(q, patch) {
  const next = { ...q, ...patch };
  const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v !== undefined && v !== ''));
  return `#/live${qs.toString() ? `?${qs}` : ''}`;
}
