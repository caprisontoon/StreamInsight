import { api } from '../api.js';
import { lineChart, platformColor } from '../charts.js';
import { $, channelHref, dateTime, duration, empty, hours, html, kpi, liveDot, liveUrl, num, platformName, timeOnly, who } from '../ui.js';

export async function render(ctx) {
  const id = ctx.params[0];
  const draw = async (fresh) => {
    const d = await api(`streams/${id}`, {}, { fresh });
    if (!ctx.isCurrent()) return;
    const s = d.stream;
    const ch = d.channel || { platform: s.platform, channelId: s.channelId };
    const color = platformColor(s.platform);
    const end = s.live ? s.lastSeenAt : s.endedAt;
    const vsAvg = d.channelAvgViewers ? (s.avgViewers - d.channelAvgViewers) / d.channelAvgViewers : null;

    ctx.el.innerHTML = String(html`
      <div class="page-head">
        <div style="min-width:0">
          <p><a href="${channelHref(ch.platform, ch.channelId)}">← ${ch.name || ch.channelId} 채널 통계</a></p>
          <h1 style="font-size:1.35rem">${s.title || '(제목 없음)'} ${s.live ? liveDot(s.currentViewers) : ''}</h1>
          <p>${dateTime(s.startedAt)} ~ ${s.live ? '방송 중' : dateTime(s.endedAt)} · ${duration(end - s.startedAt)}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${d.prevId ? html`<a class="btn btn-sm" href="#/stream/${d.prevId}">← 이전 방송</a>` : ''}
          ${d.nextId ? html`<a class="btn btn-sm" href="#/stream/${d.nextId}">다음 방송 →</a>` : ''}
          ${s.live ? html`<a class="btn btn-sm btn-primary" href="${liveUrl(s.platform, s.channelId, ch.login, s.streamKey)}" target="_blank" rel="noopener">${platformName(s.platform)}에서 시청 ↗</a>` : ''}
        </div>
      </div>
      <div class="card" style="margin-bottom:16px">${who({ ...ch, platform: s.platform, channelId: s.channelId }, ch.followers ? `팔로워 ${num(ch.followers)}명` : '')}</div>
      <div class="kpis">
        ${s.live ? kpi('현재 시청자', num(s.currentViewers)) : ''}
        ${kpi('평균 시청자', num(s.avgViewers), vsAvg !== null ? html`최근 30일 평균 대비 <span class="delta ${vsAvg > 0 ? 'up' : 'down'}">${vsAvg > 0 ? '+' : ''}${(vsAvg * 100).toFixed(0)}%</span>` : '')}
        ${kpi('최고 시청자', num(s.peakViewers))}
        ${kpi('시청 시간', hours(s.watchHours))}
        ${kpi('방송 시간', duration(s.airHours * 3600))}
      </div>
      <div class="card section">
        <div class="card-head"><h2>시청자 변화</h2>${s.live ? html`<span class="muted small">방송 중에는 1분마다 갱신</span>` : ''}</div>
        ${d.timeline.length ? html`<div class="chart-box tall"><canvas id="s-tl"></canvas></div>` : empty('스냅샷이 없습니다', '오래된 방송은 상세 기록이 정리되었을 수 있습니다')}
      </div>
      ${d.segments.length ? html`<div class="card section">
        <div class="card-head"><h2>카테고리 진행</h2></div>
        <div class="list">${d.segments.map((g) => {
          const pts = d.timeline.filter((t) => t.ts >= g.from && t.ts <= g.to);
          const avg = pts.length ? pts.reduce((a, t) => a + t.viewers, 0) / pts.length : 0;
          return html`<div class="list-row"><span class="muted num" style="width:110px">${timeOnly(g.from)} ~ ${timeOnly(g.to)}</span>
            <span class="grow"><a class="tag" href="#/category/${encodeURIComponent(g.category)}">${g.category}</a></span>
            <span class="muted small">${duration(g.to - g.from)}</span><b class="num">평균 ${num(avg)}명</b></div>`;
        })}</div>
      </div>` : ''}
    `);

    if (d.timeline.length) {
      lineChart($('#s-tl'), {
        labels: d.timeline.map((t) => timeOnly(t.ts)),
        datasets: [{ label: '시청자', data: d.timeline.map((t) => t.viewers), color }],
        area: true,
        legend: false,
      });
    }
    return s.live;
  };

  const live = await draw(false);
  if (!live) return undefined;
  const timer = setInterval(() => draw(true).catch(() => {}), 60000);
  return () => clearInterval(timer);
}
