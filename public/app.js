// ============================================================
// 网站数据看板 · 前端
// 设计：BoardUI 卡片 + 分段控件；图表走 Lieflat Glance 单色语法；
// KPI 数值过渡用 beUI Number Animation 的思路（600ms easeOut 补间）
// ============================================================
const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = { site: '', range: 'today', btype: 'url', sites: [] };

// ---------- 格式化 ----------
function fmtInt(n) { return Math.round(n).toLocaleString('zh-CN'); }
function fmtPct(r) { return (r * 100).toFixed(1) + '%'; }
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + ' 秒';
  return Math.floor(sec / 60) + ' 分 ' + String(sec % 60).padStart(2, '0') + ' 秒';
}
function fmtTime(t) {
  const d = new Date(t);
  return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':00';
}

// 数字滚动：从旧值补间到新值；减弱动效偏好下直接显示
function rollNumber(el, to, format) {
  const from = typeof el._v === 'number' ? el._v : 0;
  el._v = to;
  if (reduceMotion) { el.textContent = format(to); return; }
  const t0 = performance.now(), dur = 600;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = format(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 环比 pill：ratio 为小数；invert=true 时下降视为好（如跳出率）
function setDelta(id, ratio, invert) {
  const el = $(id);
  if (ratio === null || ratio === undefined || !isFinite(ratio)) {
    el.className = 'delta flat'; el.textContent = '—'; return;
  }
  const pct = ratio * 100;
  const good = invert ? pct <= 0 : pct >= 0;
  el.className = 'delta ' + (good ? 'up' : 'down');
  el.textContent = (pct >= 0 ? '▲' : '▼') + Math.abs(pct).toFixed(1) + '%';
}
function setDeltaPp(id, pp) {
  const el = $(id);
  if (pp === null || pp === undefined || !isFinite(pp)) {
    el.className = 'delta flat'; el.textContent = '—'; return;
  }
  const good = pp <= 0;
  el.className = 'delta ' + (good ? 'up' : 'down');
  el.textContent = (pp >= 0 ? '▲' : '▼') + Math.abs(pp * 100).toFixed(1) + 'pp';
}

// ---------- 接口 ----------
async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}
const q = (o) => new URLSearchParams(o).toString();

// ---------- 展示名映射 ----------
const COUNTRY = {
  CN: '中国', US: '美国', HK: '中国香港', TW: '中国台湾', JP: '日本', KR: '韩国',
  SG: '新加坡', GB: '英国', DE: '德国', FR: '法国', CA: '加拿大', AU: '澳大利亚',
  NL: '荷兰', RU: '俄罗斯', IN: '印度', BR: '巴西', IT: '意大利', ES: '西班牙',
};
const DEVICE = { desktop: '桌面端', mobile: '移动端', tablet: '平板' };
function displayName(type, raw) {
  if (!raw) return type === 'referrer' ? '直接访问' : '未知';
  if (type === 'country') return COUNTRY[raw] || raw;
  if (type === 'device') return DEVICE[raw] || raw;
  return raw;
}

// ---------- 分段控件 ----------
function buildSeg(el, items, getKey, getLabel, current, onPick) {
  el.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = getLabel(it);
    if (getKey(it) === current) b.classList.add('active');
    b.onclick = () => onPick(getKey(it));
    el.appendChild(b);
  }
}

// ---------- 各区块渲染 ----------
async function loadOverview() {
  const d = await api('/api/overview?' + q({ site: state.site, range: state.range }));
  rollNumber($('kpi-visitors'), d.visitors, fmtInt);
  rollNumber($('kpi-pageviews'), d.pageviews, fmtInt);
  rollNumber($('kpi-visits'), d.visits, fmtInt);
  rollNumber($('kpi-bounce'), d.bounceRate, fmtPct);
  rollNumber($('kpi-duration'), d.avgDuration, fmtDuration);
  setDelta('d-visitors', d.delta.visitors);
  setDelta('d-pageviews', d.delta.pageviews);
  setDelta('d-visits', d.delta.visits);
  setDeltaPp('d-bounce', d.delta.bounceRate);
  $('h-visitors').textContent = '上一周期：' + fmtInt(d.prev.visitors);
  $('h-pageviews').textContent = '上一周期：' + fmtInt(d.prev.pageviews);
  $('h-visits').textContent = '上一周期：' + fmtInt(d.prev.visits);
  $('h-bounce').textContent = '按访问次数计算';
  $('h-duration').textContent = '总停留 ÷ 访问次数';
  $('updated-at').textContent = fmtTime(d.updatedAt);
}

let chart = null;
async function loadTrend() {
  const d = await api('/api/trend?' + q({ site: state.site, range: state.range }));
  const labels = d.points.map((p) => {
    const dt = new Date(p.t);
    return d.unit === 'day'
      ? (dt.getMonth() + 1) + '-' + dt.getDate()
      : String(dt.getHours()).padStart(2, '0') + ':00';
  });
  if (!chart) chart = echarts.init($('trend-chart'));
  chart.setOption({
    grid: { left: 8, right: 12, top: 12, bottom: 0, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#fff',
      borderColor: '#ebebeb',
      textStyle: { color: '#0a0a0a', fontSize: 12 },
    },
    xAxis: {
      type: 'category', data: labels, boundaryGap: false,
      axisLine: { lineStyle: { color: '#ebebeb' } },
      axisTick: { show: false },
      axisLabel: { color: '#a1a1a1', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#f2f2f2' } },
      axisLabel: { color: '#a1a1a1', fontSize: 11 },
    },
    series: [
      {
        name: '浏览量', type: 'line', data: d.points.map((p) => p.pageviews),
        smooth: true, symbol: 'none',
        lineStyle: { color: '#0a0a0a', width: 2 },
        areaStyle: { color: 'rgba(10,10,10,0.05)' },
      },
      {
        name: '访问次数', type: 'line', data: d.points.map((p) => p.visits),
        smooth: true, symbol: 'none',
        lineStyle: { color: '#a1a1a1', width: 1.5, type: 'dashed' },
      },
    ],
  }, true);
}

async function loadBreakdown() {
  const d = await api('/api/breakdown?' + q({ site: state.site, range: state.range, type: state.btype }));
  const body = $('breakdown-body');
  if (!d.items.length) {
    body.innerHTML = '<div class="empty">该维度暂无数据</div>';
    return;
  }
  const max = Math.max(...d.items.map((i) => i.pageviews), 1);
  const rows = d.items.map((i) => `
    <tr>
      <td class="name" title="${escapeHtml(i.name)}">${escapeHtml(displayName(d.type, i.name))}</td>
      <td class="num" style="width:44%">
        <div class="bar-cell">
          <div class="bar-track"><div class="bar-fill" style="width:${(i.pageviews / max * 100).toFixed(1)}%"></div></div>
          <span>${fmtInt(i.pageviews)}</span>
        </div>
      </td>
      <td class="num">${fmtInt(i.visitors)}</td>
    </tr>`).join('');
  body.innerHTML = `
    <table>
      <thead><tr><th>对象</th><th class="num">浏览量</th><th class="num">访客数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadRealtime() {
  const d = await api('/api/realtime?' + q({ site: state.site }));
  rollNumber($('realtime-value'), d.visitors, fmtInt);
}

async function loadAll() {
  const jobs = [loadOverview(), loadTrend(), loadBreakdown()];
  const rs = await Promise.allSettled(jobs);
  rs.forEach((r, i) => {
    if (r.status === 'rejected') {
      const ids = ['kpis', 'trend-chart', 'breakdown-body'];
      const el = $(ids[i]);
      if (el && !el.querySelector('.card-error')) {
        const div = document.createElement('div');
        div.className = 'card-error';
        div.textContent = '数据加载失败：' + r.reason.message;
        el.appendChild(div);
      }
    }
  });
}

// ---------- 初始化 ----------
async function init() {
  const sites = await api('/api/sites');
  state.sites = sites;
  state.site = sites[0]?.name || '';

  const renderSiteSeg = () => buildSeg($('site-seg'), sites,
    (s) => s.name, (s) => s.name, state.site,
    (v) => { state.site = v; renderSiteSeg(); loadAll(); loadRealtime().catch((e) => console.error(e)); });
  renderSiteSeg();

  $('range-seg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('range-seg').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.range = b.dataset.range;
      loadAll();
    };
  });

  $('breakdown-tabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('breakdown-tabs').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.btype = b.dataset.type;
      loadBreakdown().catch((e) => console.error(e));
    };
  });

  await loadAll();
  await loadRealtime().catch((e) => console.error(e));
  setInterval(() => loadRealtime().catch((e) => console.error(e)), 30000);
  addEventListener('resize', () => chart && chart.resize());
}

init().catch((e) => {
  document.querySelector('.page').insertAdjacentHTML('afterbegin',
    '<div class="card"><div class="card-error">初始化失败：' + escapeHtml(e.message) + '</div></div>');
});
