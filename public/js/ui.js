// 공통 UI 헬퍼: 안전한 HTML 템플릿, 숫자/날짜 포맷, 공용 컴포넌트, 즐겨찾기/비교 저장소

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function fmtVal(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(fmtVal).join('');
  if (v instanceof Raw) return v.s;
  return esc(v);
}

/** 보간값을 자동으로 이스케이프하는 템플릿 태그 */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += fmtVal(vals[i]);
  });
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- 플랫폼 ----------
export const PLATFORMS = {
  chzzk: { id: 'chzzk', name: '치지직', color: '#00b679' },
  soop: { id: 'soop', name: 'SOOP', color: '#2f6bff' },
  twitch: { id: 'twitch', name: '트위치', color: '#9146ff' },
};
export const PLATFORM_IDS = Object.keys(PLATFORMS);
export const platformName = (p) => PLATFORMS[p]?.name ?? p;

export function channelUrl(platform, id, login) {
  if (platform === 'chzzk') return `https://chzzk.naver.com/${encodeURIComponent(id)}`;
  if (platform === 'soop') return `https://ch.sooplive.co.kr/${encodeURIComponent(id)}`;
  if (platform === 'twitch') return `https://www.twitch.tv/${encodeURIComponent(login || id)}`;
  return '#';
}
export function liveUrl(platform, id, login) {
  if (platform === 'chzzk') return `https://chzzk.naver.com/live/${encodeURIComponent(id)}`;
  if (platform === 'soop') return `https://play.sooplive.co.kr/${encodeURIComponent(id)}`;
  return channelUrl(platform, id, login);
}

// ---------- 포맷 ----------
const nf = new Intl.NumberFormat('ko-KR');
export const num = (n) => (n === null || n === undefined || Number.isNaN(n) ? '-' : nf.format(Math.round(n)));

/** 12,345 → 1.2만 */
export function compact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e8) return `${trim(n / 1e8)}억`;
  if (a >= 1e4) return `${trim(n / 1e4)}만`;
  if (a >= 1e3) return nf.format(Math.round(n));
  return nf.format(Math.round(n * 10) / 10);
}
const trim = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString('ko-KR');

export function hours(h) {
  if (h === null || h === undefined) return '-';
  if (h === 0) return '0';
  if (h < 1) return `${Math.round(h * 60)}분`;
  if (h < 100) return `${Math.round(h * 10) / 10}시간`;
  return `${compact(h)}시간`;
}

export function duration(sec) {
  if (sec === null || sec === undefined) return '-';
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}시간 ${m % 60}분` : `${m}분`;
}

export const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;

const KST = 9 * 3600 * 1000;
const kst = (ts) => new Date(ts * 1000 + KST);
const pad = (n) => String(n).padStart(2, '0');
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
export const DOW_NAMES = DOW;

export function dateTime(ts) {
  if (!ts) return '-';
  const d = kst(ts);
  return `${d.getUTCMonth() + 1}.${d.getUTCDate()}(${DOW[d.getUTCDay()]}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function timeOnly(ts) {
  const d = kst(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function shortDate(date) {
  const [, m, d] = date.split('-').map(Number);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `${m}.${d}(${DOW[dow]})`;
}
export function ago(ts) {
  if (!ts) return '-';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return dateTime(ts);
}

// ---------- 기간 ----------
export function todayKst() {
  return new Date(Date.now() + KST).toISOString().slice(0, 10);
}
export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export const PERIODS = [
  { id: 'today', label: '오늘' },
  { id: 'yesterday', label: '어제' },
  { id: '7d', label: '7일' },
  { id: '30d', label: '30일' },
  { id: '90d', label: '90일' },
  { id: 'month', label: '이번 달' },
  { id: 'lastmonth', label: '지난 달' },
  { id: 'custom', label: '직접 선택' },
];

export function periodRange(q, fallback = '7d') {
  const t = todayKst();
  const id = q.period || (q.from && q.to ? 'custom' : fallback);
  switch (id) {
    case 'today': return { id, from: t, to: t };
    case 'yesterday': return { id, from: addDays(t, -1), to: addDays(t, -1) };
    case '30d': return { id, from: addDays(t, -29), to: t };
    case '90d': return { id, from: addDays(t, -89), to: t };
    case 'month': return { id, from: `${t.slice(0, 8)}01`, to: t };
    case 'lastmonth': {
      const first = `${t.slice(0, 8)}01`;
      const lastEnd = addDays(first, -1);
      return { id, from: `${lastEnd.slice(0, 8)}01`, to: lastEnd };
    }
    case 'custom': return { id, from: q.from || addDays(t, -6), to: q.to || t };
    default: return { id: '7d', from: addDays(t, -6), to: t };
  }
}

export function periodLabel(r) {
  if (r.from === r.to) return shortDate(r.from);
  return `${shortDate(r.from)} ~ ${shortDate(r.to)}`;
}

// ---------- 컴포넌트 ----------
export function platformBadge(p, small = false) {
  return html`<span class="pbadge pbadge-${p}${small ? ' sm' : ''}" title="${platformName(p)}">${platformName(p)}</span>`;
}

export function avatar(name, image, platform, size = 40) {
  const initial = (name || '?').trim().slice(0, 1);
  const img = image && /^https?:\/\//.test(image) ? html`<img src="${image}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  return html`<span class="avatar ring-${platform || 'none'}" style="--size:${size}px"><span class="avatar-fallback">${initial}</span>${img}</span>`;
}

export function liveDot(viewers) {
  return html`<span class="live-pill"><span class="dot"></span>LIVE${viewers !== undefined && viewers !== null ? html` <b>${num(viewers)}</b>` : ''}</span>`;
}

export function rankChange(rank, prev) {
  if (prev === null || prev === undefined) return html`<span class="rc rc-new">NEW</span>`;
  const d = prev - rank;
  if (d > 0) return html`<span class="rc rc-up">▲${d}</span>`;
  if (d < 0) return html`<span class="rc rc-down">▼${-d}</span>`;
  return html`<span class="rc rc-same">-</span>`;
}

export function kpi(label, value, sub = '', hint = '') {
  return html`<div class="kpi" ${hint ? raw(`title="${esc(hint)}"`) : ''}><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? html`<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

export function delta(now, before) {
  if (!before) return '';
  const d = (now - before) / before;
  const cls = d > 0.005 ? 'up' : d < -0.005 ? 'down' : 'same';
  const sign = d > 0 ? '+' : '';
  return html`<span class="delta ${cls}">${sign}${(d * 100).toFixed(1)}%</span>`;
}

export function empty(msg = '데이터가 없습니다', sub = '') {
  return html`<div class="empty"><div class="empty-icon">📭</div><div>${msg}</div>${sub ? html`<div class="muted small">${sub}</div>` : ''}</div>`;
}

export function loading() {
  return html`<div class="loading"><div class="spinner"></div></div>`;
}

export function thumb(url, alt = '') {
  if (url && /^https?:\/\//.test(url)) {
    return html`<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.classList.add('noimg');this.remove()">`;
  }
  return '';
}

/** 기간 선택기 (칩 + 직접 선택) */
export function periodPicker(range) {
  return html`
    <div class="period-picker" data-period-picker>
      <div class="chips">
        ${PERIODS.map((p) => html`<button type="button" class="chip ${range.id === p.id ? 'active' : ''}" data-period="${p.id}">${p.label}</button>`)}
      </div>
      <div class="custom-range ${range.id === 'custom' ? '' : 'hidden'}">
        <input type="date" name="from" value="${range.from}" max="${todayKst()}">
        <span>~</span>
        <input type="date" name="to" value="${range.to}" max="${todayKst()}">
        <button type="button" class="btn btn-sm" data-apply-range>적용</button>
      </div>
    </div>`;
}

export function platformFilter(current, { allowAll = true } = {}) {
  const opts = [...(allowAll ? [{ id: 'all', name: '전체' }] : []), ...Object.values(PLATFORMS)];
  return html`<div class="chips" data-platform-filter>
    ${opts.map((p) => html`<button type="button" class="chip chip-${p.id} ${(current || 'all') === p.id ? 'active' : ''}" data-platform="${p.id}">${p.id !== 'all' ? html`<span class="pdot pdot-${p.id}"></span>` : ''}${p.name}</button>`)}
  </div>`;
}

// ---------- 로컬 저장소 (로그인 없이 즐겨찾기/비교) ----------
function load(key, d) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? d;
  } catch {
    return d;
  }
}
function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 저장 불가 환경은 무시
  }
}

export const favorites = {
  all: () => load('si:favorites', []),
  has: (platform, id) => favorites.all().some((f) => f.platform === platform && f.channelId === id),
  toggle(ch) {
    const list = favorites.all();
    const i = list.findIndex((f) => f.platform === ch.platform && f.channelId === ch.channelId);
    if (i >= 0) list.splice(i, 1);
    else list.unshift({ platform: ch.platform, channelId: ch.channelId, name: ch.name, image: ch.image });
    save('si:favorites', list);
    return i < 0;
  },
};

export const compareList = {
  MAX: 6,
  all: () => load('si:compare', []),
  set: (list) => save('si:compare', list.slice(0, compareList.MAX)),
  has: (platform, id) => compareList.all().some((f) => f.platform === platform && f.channelId === id),
  add(ch) {
    const list = compareList.all().filter((f) => !(f.platform === ch.platform && f.channelId === ch.channelId));
    list.push({ platform: ch.platform, channelId: ch.channelId, name: ch.name, image: ch.image });
    compareList.set(list.slice(-compareList.MAX));
  },
  remove(platform, id) {
    compareList.set(compareList.all().filter((f) => !(f.platform === platform && f.channelId === id)));
  },
};

export const prefs = {
  get: (k, d) => load(`si:pref:${k}`, d),
  set: (k, v) => save(`si:pref:${k}`, v),
};

let toastTimer;
export function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

export function channelHref(platform, id) {
  return `#/channel/${platform}/${encodeURIComponent(id)}`;
}

/** 해시 링크 생성: href('/ranking', { period: '7d' }) → '#/ranking?period=7d' */
export function href(path, query = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 'all'));
  return `#${path}${qs.toString() ? `?${qs}` : ''}`;
}

/** 라이브 방송 카드 */
export function liveCard(it) {
  const up = it.startedAt ? duration(Math.floor(Date.now() / 1000) - it.startedAt) : '';
  return html`
    <a class="live-card" href="${it.streamId ? `#/stream/${it.streamId}` : channelHref(it.platform, it.channelId)}">
      <div class="live-thumb">
        <span class="ph">${(it.name || '?').slice(0, 1)}</span>
        ${thumb(it.thumbnail)}
        ${liveDot(it.viewers)}
        ${platformBadge(it.platform, true)}
        ${up ? html`<span class="uptime">${up}</span>` : ''}
      </div>
      <div class="live-meta">
        ${avatar(it.name, it.image, it.platform, 36)}
        <div class="live-meta-text">
          <div class="live-title" title="${it.title || ''}">${it.title || '(제목 없음)'}</div>
          <div class="live-name"><span class="n">${it.name || it.channelId}</span>${it.category ? html`<span class="tag">${it.category}</span>` : ''}</div>
        </div>
      </div>
    </a>`;
}

/** 채널 이름 셀 (아바타 + 이름 + 부가정보) */
export function who(it, sub = '') {
  return html`
    <a class="who" href="${channelHref(it.platform, it.channelId)}">
      ${avatar(it.name, it.image, it.platform, 38)}
      <span class="who-text">
        <span class="who-name"><span class="n">${it.name || it.channelId}</span>${platformBadge(it.platform, true)}</span>
        ${sub ? html`<span class="who-sub">${sub}</span>` : ''}
      </span>
    </a>`;
}
