// API 호출 헬퍼 (짧은 메모리 캐시 포함)
const cache = new Map();
const TTL = 30 * 1000;

export async function api(path, params = {}, { fresh = false } = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const url = `/api/${path}${qs.toString() ? `?${qs}` : ''}`;
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.t < TTL) return hit.data;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `요청 실패 (${res.status})`), { status: res.status });
  cache.set(url, { t: Date.now(), data });
  return data;
}

export function csvUrl(path, params = {}) {
  const qs = new URLSearchParams(Object.entries({ ...params, format: 'csv' }).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return `/api/${path}?${qs}`;
}
