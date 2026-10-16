export const KST_OFFSET = 9 * 3600;

/** 유닉스 초 → KST 기준 'YYYY-MM-DD' */
export function kstDate(ts) {
  return new Date((ts + KST_OFFSET) * 1000).toISOString().slice(0, 10);
}

/** KST 'YYYY-MM-DD HH:mm:ss' 문자열 → 유닉스 초 */
export function parseKst(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s || 0) / 1000 - KST_OFFSET;
}

/** 'YYYY-MM-DD' 에 days 일을 더한 날짜 */
export function addDays(date, days) {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

/** KST 날짜의 00:00:00 유닉스 초 */
export function kstDayStart(date) {
  return Date.parse(`${date}T00:00:00Z`) / 1000 - KST_OFFSET;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** 타임아웃·재시도를 포함한 JSON 요청 */
export function fetchJson(url, opts = {}) {
  return request(url, { ...opts, accept: 'application/json', parse: (res) => res.json() });
}

/** 타임아웃·재시도를 포함한 텍스트 요청 (RSS 등) */
export function fetchText(url, opts = {}) {
  return request(url, { ...opts, accept: '*/*', parse: (res) => res.text() });
}

async function request(url, { headers = {}, retries = 2, timeoutMs = 15000, method = 'GET', body, accept, parse }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, Accept: accept, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url}`);
        err.status = res.status;
        // 4xx 는 재시도해도 결과가 같으므로 바로 실패 (429 제외)
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return await parse(res);
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === retries) break;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  // 엑셀에서 한글이 깨지지 않도록 BOM 추가
  return '﻿' + [head, ...body].join('\r\n');
}
