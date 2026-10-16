import { api } from './api.js';
import { destroyCharts } from './charts.js';
import { $, PLATFORMS, ago, avatar, channelHref, empty, href, html, liveDot, loading, num, platformBadge, prefs, toast } from './ui.js';

import * as home from './pages/home.js';
import * as live from './pages/live.js';
import * as ranking from './pages/ranking.js';
import * as categories from './pages/categories.js';
import * as category from './pages/category.js';
import * as platforms from './pages/platforms.js';
import * as channel from './pages/channel.js';
import * as stream from './pages/stream.js';
import * as compare from './pages/compare.js';
import * as favorites from './pages/favorites.js';
import * as about from './pages/about.js';

const ROUTES = [
  { re: /^\/?$/, page: home, nav: 'home' },
  { re: /^\/live$/, page: live, nav: 'live' },
  { re: /^\/ranking$/, page: ranking, nav: 'ranking' },
  { re: /^\/categories$/, page: categories, nav: 'categories' },
  { re: /^\/category\/(.+)$/, page: category, nav: 'categories' },
  { re: /^\/platforms$/, page: platforms, nav: 'platforms' },
  { re: /^\/channel\/(\w+)\/(.+)$/, page: channel, nav: '' },
  { re: /^\/stream\/(\d+)$/, page: stream, nav: '' },
  { re: /^\/compare$/, page: compare, nav: 'compare' },
  { re: /^\/favorites$/, page: favorites, nav: 'favorites' },
  { re: /^\/about$/, page: about, nav: 'about' },
];

const app = $('#app');
let cleanup = null;
let lastPath = null;
let renderSeq = 0;

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = h.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
}

function navigate(hash) {
  location.hash = hash;
}

function setQuery(patch) {
  const { path, query } = parseHash();
  const next = { ...query, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  navigate(href(path, next));
}

async function render() {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  const route = ROUTES.find((r) => r.re.test(path));
  if (cleanup) {
    try {
      cleanup();
    } catch {
      // 무시
    }
    cleanup = null;
  }
  destroyCharts();

  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', route && a.dataset.nav === route.nav));
  if (path !== lastPath) {
    window.scrollTo(0, 0);
    app.innerHTML = String(loading());
  }
  lastPath = path;

  if (!route) {
    app.innerHTML = String(empty('페이지를 찾을 수 없습니다', '주소를 확인해 주세요'));
    return;
  }
  const params = path.match(route.re).slice(1).map(decodeURIComponent);
  const ctx = {
    el: app,
    params,
    query,
    setQuery,
    navigate,
    refresh: render,
    isCurrent: () => seq === renderSeq,
  };
  try {
    const out = await route.page.render(ctx);
    if (seq === renderSeq && typeof out === 'function') cleanup = out;
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    app.innerHTML = String(empty(err.status === 404 ? '찾을 수 없습니다' : '데이터를 불러오지 못했습니다', err.message));
  }
}

// ---------- 공용 이벤트: 기간/플랫폼 필터 ----------
app.addEventListener('click', (e) => {
  const period = e.target.closest('[data-period]');
  if (period) {
    const picker = period.closest('[data-period-picker]');
    if (period.dataset.period === 'custom') {
      picker.querySelector('.custom-range').classList.remove('hidden');
      picker.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', b === period));
      return;
    }
    setQuery({ period: period.dataset.period, from: undefined, to: undefined, page: undefined });
    return;
  }
  const apply = e.target.closest('[data-apply-range]');
  if (apply) {
    const picker = apply.closest('[data-period-picker]');
    const from = picker.querySelector('[name=from]').value;
    const to = picker.querySelector('[name=to]').value;
    if (!from || !to) return toast('시작일과 종료일을 선택해 주세요');
    setQuery({ period: 'custom', from: from <= to ? from : to, to: from <= to ? to : from, page: undefined });
    return;
  }
  const plat = e.target.closest('[data-platform]');
  if (plat && plat.closest('[data-platform-filter]')) {
    setQuery({ platform: plat.dataset.platform === 'all' ? undefined : plat.dataset.platform, page: undefined });
  }
});

// ---------- 테마 ----------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const btn = $('#theme-toggle');
  const isDark = t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  btn.textContent = isDark ? '☀️' : '🌙';
  btn.title = isDark ? '라이트 모드' : '다크 모드';
}
applyTheme(prefs.get('theme', null));
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  prefs.set('theme', next);
  applyTheme(next);
  render();
});

// ---------- 전역 검색 ----------
const searchInput = $('#search');
const searchBox = $('#search-results');
let searchTimer;
let searchItems = [];
let searchIndex = -1;

function closeSearch() {
  searchBox.hidden = true;
  searchIndex = -1;
}
function renderSearch() {
  if (!searchItems.length) {
    searchBox.innerHTML = String(html`<div class="search-empty">검색 결과가 없습니다</div>`);
  } else {
    searchBox.innerHTML = String(html`${searchItems.map((c, i) => html`
      <a class="search-item ${i === searchIndex ? 'active' : ''}" href="${channelHref(c.platform, c.channelId)}" data-i="${i}">
        ${avatar(c.name, c.image, c.platform, 32)}
        <span class="search-name">${c.name || c.channelId}<span class="muted small">${c.followers ? ` · 팔로워 ${num(c.followers)}` : ''}</span></span>
        ${c.liveViewers !== null && c.liveViewers !== undefined ? liveDot(c.liveViewers) : html`<span class="muted small">${ago(c.lastLiveAt)}</span>`}
        ${platformBadge(c.platform, true)}
      </a>`)}`);
  }
  searchBox.hidden = false;
}
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) return closeSearch();
  searchTimer = setTimeout(async () => {
    try {
      const r = await api('search', { q, limit: 8 });
      if (searchInput.value.trim() !== q) return;
      searchItems = r.items;
      searchIndex = -1;
      renderSearch();
    } catch {
      closeSearch();
    }
  }, 180);
});
searchInput.addEventListener('keydown', (e) => {
  if (searchBox.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = searchItems.length;
    if (!n) return;
    searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderSearch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const c = searchItems[searchIndex >= 0 ? searchIndex : 0];
    if (c) {
      navigate(channelHref(c.platform, c.channelId));
      searchInput.value = '';
      searchInput.blur();
      closeSearch();
    }
  } else if (e.key === 'Escape') {
    closeSearch();
    searchInput.blur();
  }
});
searchBox.addEventListener('click', () => {
  searchInput.value = '';
  closeSearch();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) closeSearch();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ---------- 상태 표시 (데모 배너, 마지막 수집 시각) ----------
async function refreshStatus() {
  try {
    const s = await api('status', {}, { fresh: true });
    $('#demo-banner').hidden = !s.demo;
    const ok = s.platforms.filter((p) => p.lastSuccessAt);
    const last = ok.length ? Math.max(...ok.map((p) => p.lastSuccessAt)) : null;
    $('#footer-status').innerHTML = String(html`
      ${s.platforms.map((p) => html`<span class="status-item" title="${p.lastError || ''}"><span class="pdot pdot-${p.platform} ${p.lastError ? 'err' : ''}"></span>${PLATFORMS[p.platform]?.name || p.platform} ${p.lastError ? '오류' : 'OK'}</span>`)}
      <span class="muted">마지막 수집 ${last ? ago(last) : '없음'} · ${Math.round(s.intervalSec / 60)}분 간격 · 채널 ${num(s.channels)}개 추적 중</span>`);
  } catch {
    // 무시
  }
}

window.addEventListener('hashchange', render);
render();
refreshStatus();
setInterval(refreshStatus, 60000);

