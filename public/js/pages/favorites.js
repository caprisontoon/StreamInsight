import { api } from '../api.js';
import { ago, empty, favorites, hours, html, liveDot, num, toast, who } from '../ui.js';

export async function render(ctx) {
  const favs = favorites.all();
  if (!favs.length) {
    ctx.el.innerHTML = String(html`
      <div class="page-head"><div><h1>즐겨찾기</h1><p>로그인 없이 이 브라우저에 저장됩니다</p></div></div>
      <div class="card">${empty('아직 즐겨찾기한 스트리머가 없어요', '스트리머 페이지에서 ☆ 즐겨찾기를 눌러 추가하세요')}</div>`);
    return;
  }
  const d = await api('channels-batch', { ids: favs.map((f) => `${f.platform}:${f.channelId}`).join(','), from: weekAgo(), to: today() }, { fresh: true });
  if (!ctx.isCurrent()) return;
  const items = [...d.items].sort((a, b) => (b.live?.viewers ?? -1) - (a.live?.viewers ?? -1));
  const liveCount = items.filter((i) => i.live).length;

  ctx.el.innerHTML = String(html`
    <div class="page-head"><div><h1>즐겨찾기</h1><p>${num(items.length)}명 중 <b>${liveCount}명</b> 방송 중 · 최근 7일 통계</p></div></div>
    <div class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th class="l">스트리머</th><th class="l">상태</th><th>평균 시청자</th><th>최고 시청자</th><th>방송 시간</th><th>팔로워</th><th></th></tr></thead>
      <tbody>${items.map((i) => html`<tr>
        <td class="l">${who(i, i.live ? `${i.live.category || ''} · ${i.live.title || ''}` : '')}</td>
        <td class="l">${i.live ? html`<a href="#/stream/${i.live.streamId}">${liveDot(i.live.viewers)}</a>` : html`<span class="muted small">${i.lastLiveAt ? `${ago(i.lastLiveAt)} 방송` : '오프라인'}</span>`}</td>
        <td><b>${num(i.avgViewers)}</b></td><td>${num(i.peakViewers)}</td><td>${hours(i.airHours)}</td><td>${i.followers ? num(i.followers) : '-'}</td>
        <td><button class="btn btn-sm" data-remove="${i.platform}:${i.channelId}" title="즐겨찾기 해제">✕</button></td>
      </tr>`)}</tbody>
    </table></div></div>`);

  ctx.el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    const [platform, ...rest] = b.dataset.remove.split(':');
    favorites.toggle({ platform, channelId: rest.join(':') });
    toast('즐겨찾기에서 뺐어요');
    render(ctx);
  }));
}

const KST = 9 * 3600 * 1000;
const today = () => new Date(Date.now() + KST).toISOString().slice(0, 10);
const weekAgo = () => new Date(Date.now() + KST - 6 * 86400000).toISOString().slice(0, 10);
