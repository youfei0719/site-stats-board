// ============================================================
// 网站数据看板 v2 · 前端
// 信息架构融合：GA4（左侧分组导航 / 指标选择器 / 上期虚线对比 / 实时卡片）
// ＋ Plausible（KPI 条 → 大趋势图 → 明细表紧凑总览）＋ 百度统计（渠道分组 /
// 搜索引擎表 / 受访页面列定义）＋ 友盟+（实时呈现 / 密报表）＋ Mixpanel
// （Boards 留白节奏 / 克制条形）。视觉只用 BoardUI token。
// ============================================================
const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  site: '', range: 'today', view: 'overview',
  ovMetric: 'visitors', ovCompare: false,
  tfMetric: 'visitors', tfCompare: false,
  sites: [],
};

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
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 数字滚动：beUI 思路，600ms easeOut 补间；减弱动效偏好下直接显示
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

// 环比 pill；invert=true 时下降视为好（如跳出率）
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
// 差值 pill（如平均访问页数变化，单位：页）
function setDeltaDiff(id, diff, suffix) {
  const el = $(id);
  if (diff === null || diff === undefined || !isFinite(diff)) {
    el.className = 'delta flat'; el.textContent = '—'; return;
  }
  const good = diff >= 0;
  el.className = 'delta ' + (good ? 'up' : 'down');
  el.textContent = (diff >= 0 ? '▲' : '▼') + Math.abs(diff).toFixed(1) + suffix;
}

// ---------- 接口 ----------
async function api(path) {
  const res = await fetch(path);
  if (res.status === 401) { location.href = 'login.html'; throw new Error('未登录'); }
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

// ---------- 通用渲染 ----------
// 空状态只写"暂无数据"四个字
const EMPTY = '<div class="empty">暂无数据</div>';

// 明细表：对象 / 浏览量(条形+数字) / 访客数 —— BoardUI 表格规范
function breakdownTable(items, nameCol) {
  if (!items.length) return EMPTY;
  const max = Math.max(...items.map((i) => i.pageviews), 1);
  const rows = items.map((i) => `
    <tr>
      <td class="name" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</td>
      <td class="num" style="width:42%">
        <div class="bar-cell">
          <div class="bar-track"><div class="bar-fill" style="width:${(i.pageviews / max * 100).toFixed(1)}%"></div></div>
          <span>${fmtInt(i.pageviews)}</span>
        </div>
      </td>
      <td class="num">${fmtInt(i.visitors)}</td>
    </tr>`).join('');
  return `
    <table>
      <thead><tr><th>${nameCol}</th><th class="num">浏览量</th><th class="num">访客数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// 迷你列表：名 / 数（实时明细、Top5 紧凑行）
function miniList(items, type) {
  if (!items.length) return EMPTY;
  return '<div class="mini-list">' + items.map((i) => `
    <div class="mini-row">
      <span class="mini-name" title="${escapeHtml(i.name)}">${escapeHtml(displayName(type, i.name))}</span>
      <span class="mini-num">${fmtInt(i.count ?? i.pageviews ?? 0)}</span>
    </div>`).join('') + '</div>';
}

function showError(el, msg) {
  el.innerHTML = '<div class="card-error">' + escapeHtml(msg) + '</div>';
}

// ---------- 图表 ----------
const charts = {};
function getChart(id) {
  if (!charts[id]) charts[id] = echarts.init($(id));
  return charts[id];
}
function resizeCharts() {
  Object.values(charts).forEach((c) => { try { c.resize(); } catch { /* 忽略 */ } });
}

const METRIC_NAMES = { visitors: '访客数', pageviews: '浏览量', visits: '访问次数' };
const AXIS_STYLE = {
  axisLine: { lineStyle: { color: '#ebebeb' } },
  axisTick: { show: false },
  axisLabel: { color: '#a1a1a1', fontSize: 11 },
};
const TOOLTIP = {
  trigger: 'axis',
  backgroundColor: '#fff',
  borderColor: '#ebebeb',
  textStyle: { color: '#0a0a0a', fontSize: 12 },
};

// 趋势图：GA4 式 —— 指标选择器切换单条实线，上期对比为灰色虚线叠加
function trendOption(points, prevPoints, metric, unit, showPrev) {
  const labels = points.map((p) => {
    const dt = new Date(p.t);
    return unit === 'day'
      ? (dt.getMonth() + 1) + '-' + dt.getDate()
      : String(dt.getHours()).padStart(2, '0') + ':00';
  });
  const series = [{
    name: METRIC_NAMES[metric], type: 'line',
    data: points.map((p) => p[metric] || 0),
    smooth: true, symbol: 'none',
    lineStyle: { color: '#2dd4bf', width: 2 },
    areaStyle: { color: 'rgba(45,212,191,0.08)' },
  }];
  if (showPrev && prevPoints && prevPoints.length) {
    // 按索引对齐上期（桶数量一致时即为同期对比）
    const prevData = points.map((_, i) => (prevPoints[i] ? prevPoints[i][metric] || 0 : null));
    series.push({
      name: '上期', type: 'line', data: prevData,
      smooth: true, symbol: 'none',
      lineStyle: { color: '#a1a1a1', width: 1.5, type: 'dashed' },
    });
  }
  return {
    grid: { left: 8, right: 12, top: 12, bottom: 0, containLabel: true },
    tooltip: TOOLTIP,
    xAxis: { type: 'category', data: labels, boundaryGap: false, ...AXIS_STYLE },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f2f2f2' } }, axisLabel: AXIS_STYLE.axisLabel },
    series,
  };
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
function wireTabs(el, attr, current, onPick) {
  el.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset[attr] === current);
    b.onclick = () => {
      el.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onPick(b.dataset[attr]);
    };
  });
}

// ---------- KPI 卡（4 张，BoardUI 模板式：只放最核心的）----------
// 产品逻辑：总览只回答"网站现在怎么样"——访客数（人）、浏览量（量）、跳出率（质量）、平均停留（粘性）
// 访问次数、平均访问页数移到流量分析去做深度解读
const KPI_DEFS = [
  { id: 'visitors', label: '访客数', fmt: fmtInt, icon: '👥', color: '#2dd4bf', bg: '#ccfbf1' },
  { id: 'pageviews', label: '浏览量', fmt: fmtInt, icon: '👁️', color: '#60a5fa', bg: '#dbeafe' },
  { id: 'bounce', label: '跳出率', fmt: fmtPct, invert: true, hint: '按访问次数计算', icon: '📤', color: '#f472b6', bg: '#fce7f3' },
  { id: 'duration', label: '平均停留', fmt: fmtDuration, hint: '总停留 ÷ 访问次数', icon: '⏱️', color: '#facc15', bg: '#fef9c3' },
];
function buildKpis() {
  $('kpis').innerHTML = KPI_DEFS.map((k) => `
    <div class="kpi">
      <div class="kpi-top"><span class="kpi-icon" style="background:${k.bg};color:${k.color}">${k.icon}</span><span class="kpi-label">${k.label}</span></div>
      <div class="kpi-row"><span class="kpi-value" id="kpi-${k.id}">—</span><span class="delta flat" id="d-${k.id}">—</span></div>
      <div class="kpi-hint" id="h-${k.id}"></div>
    </div>`).join('');
}

// ---------- 各视图加载 ----------
// 总览
async function loadOverview() {
  const d = await api('api/overview?' + q({ site: state.site, range: state.range }));
  const realPv = d.realPageviews ?? d.pageviews;
  const selfPv = d.selfPageviews ?? 0;

  rollNumber($('kpi-visitors'), d.visitors, fmtInt);
  rollNumber($('kpi-pageviews'), realPv, fmtInt);
  rollNumber($('kpi-bounce'), d.bounceRate, fmtPct);
  rollNumber($('kpi-duration'), d.avgDuration, fmtDuration);
  setDelta('d-visitors', d.delta.visitors);
  setDelta('d-pageviews', d.delta.pageviews);
  setDeltaPp('d-bounce', d.delta.bounceRate);
  setDelta('d-duration', d.delta.duration);
  const prevLabel = state.range === 'today' ? '昨日此时：' : '上一周期：';
  $('h-visitors').textContent = prevLabel + fmtInt(d.prev.visitors);
  $('h-pageviews').textContent = selfPv > 0
    ? `已排除看板自流量 ${fmtInt(selfPv)} 次`
    : prevLabel + fmtInt(d.prev.pageviews);
  $('h-bounce').textContent = '按访问次数计算';
  $('h-duration').textContent = '总停留 ÷ 访问次数';
  $('h-avgPages').textContent = '浏览量 ÷ 访问次数';
  $('updated-at').textContent = fmtTime(d.updatedAt);

  // 趋势（指标切换＋上期对比）
  const t = await api('api/trend?' + q({
    site: state.site, range: state.range,
    ...(state.ovCompare ? { compare: 'prev' } : {}),
  }));
  getChart('ov-trend').setOption(
    trendOption(t.points, t.prevPoints, state.ovMetric, t.unit, state.ovCompare), true);

  // 来源 Top5 / 热门页面 Top5（并行）
  const [ch, pg] = await Promise.all([
    api('api/channel?' + q({ site: state.site, range: state.range })).catch(() => null),
    api('api/pages?' + q({ site: state.site, range: state.range })).catch(() => null),
  ]);
  $('ov-sources').innerHTML = ch
    ? breakdownTable(ch.domains.slice(0, 5).map((x) => ({ ...x })), '来源')
    : EMPTY;
  $('ov-pages').innerHTML = pg ? breakdownTable(pg.items.slice(0, 5), '页面') : EMPTY;

  loadRealtimeStrip().catch((e) => console.error(e));
}

async function loadRealtimeStrip() {
  const d = await api('api/realtime?' + q({ site: state.site }));
  rollNumber($('rt-strip'), d.visitors, fmtInt);
}

// 流量分析
async function loadTraffic() {
  const t = await api('api/trend?' + q({
    site: state.site, range: state.range,
    ...(state.tfCompare ? { compare: 'prev' } : {}),
  }));
  getChart('tf-chart').setOption(
    trendOption(t.points, t.prevPoints, state.tfMetric, t.unit, state.tfCompare), true);

  const h = await api('api/hourly?' + q({ site: state.site, range: state.range }));
  if (!h.hours.length) {
    // 24 小时分布仅支持今日 / 昨日：保留图表实例，只显示空状态文字
    getChart('hourly-chart').setOption({
      graphic: [{
        type: 'text', left: 'center', top: 'middle',
        style: { text: '暂无数据', fill: '#a1a1a1', fontSize: 13 },
      }],
      xAxis: { show: false }, yAxis: { show: false }, series: [],
    }, true);
    return;
  }
  getChart('hourly-chart').setOption({
    grid: { left: 8, right: 12, top: 12, bottom: 0, containLabel: true },
    tooltip: { ...TOOLTIP, formatter: (ps) => `${ps[0].name}：浏览量 ${ps[0].value}` },
    xAxis: {
      type: 'category',
      data: h.hours.map((x) => String(x.hour).padStart(2, '0')),
      ...AXIS_STYLE,
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f2f2f2' } }, axisLabel: AXIS_STYLE.axisLabel },
    series: [{
      type: 'bar',
      data: h.hours.map((x) => x.pageviews),
      itemStyle: { color: '#2dd4bf', borderRadius: [3, 3, 0, 0] },
      barWidth: '62%',
    }],
  }, true);
}

// 来源分析：BoardUI 最新图表 8 色调色板（teal/lime/pink/sky/purple/blue/emerald/yellow）
const DONUT_PALETTE = ['#2dd4bf', '#a3e635', '#f472b6', '#38bdf8', '#c084fc', '#60a5fa', '#34d399', '#facc15'];
const CHART_ACCENT = '#2dd4bf'; // 主强调色 teal
async function loadSource() {
  const d = await api('api/channel?' + q({ site: state.site, range: state.range }));
  getChart('channel-donut').setOption({
    tooltip: { ...TOOLTIP, trigger: 'item', formatter: '{b}：{c}（{d}%）' },
    legend: { bottom: 0, textStyle: { color: '#737373', fontSize: 12 } },
    series: [{
      type: 'pie', radius: ['55%', '76%'], center: ['50%', '42%'],
      itemStyle: { borderColor: '#fff', borderWidth: 2 },
      label: { color: '#737373', fontSize: 12, formatter: '{b}\n{d}%' },
      labelLine: { lineStyle: { color: '#d4d4d4' } },
      data: d.channels.map((c, i) => ({
        name: c.channel, value: c.pageviews,
        itemStyle: { color: DONUT_PALETTE[i % DONUT_PALETTE.length] },
      })),
    }],
  }, true);

  $('channel-table').innerHTML = breakdownTable(
    d.channels.map((c) => ({ name: c.channel, pageviews: c.pageviews, visitors: c.visitors })), '渠道');
  $('domain-table').innerHTML = breakdownTable(d.domains, '来源域名');
  $('engine-table').innerHTML = d.engines.length
    ? `<table><thead><tr><th>搜索引擎</th><th class="num">浏览量</th><th class="num">访客数</th></tr></thead>
       <tbody>${d.engines.map((e) => `
         <tr><td>${escapeHtml(e.name)}</td><td class="num">${fmtInt(e.pageviews)}</td><td class="num">${fmtInt(e.visitors)}</td></tr>`).join('')}
       </tbody></table>`
    : EMPTY;
}

// 页面分析
async function loadPages() {
  const d = await api('api/pages?' + q({ site: state.site, range: state.range }));
  let html = breakdownTable(d.items, '页面');
  if (d.selfItems && d.selfItems.length) {
    html += `<div class="card-title" style="margin-top:16px">看板自流量（已从上方排除）</div>`
      + breakdownTable(d.selfItems, '页面');
  }
  $('pages-table').innerHTML = html;
}

// 访客分析
async function loadVisitors() {
  const types = [
    ['country', 'v-country'], ['browser', 'v-browser'], ['os', 'v-os'], ['device', 'v-device'],
  ];
  const results = await Promise.all(types.map(([t]) =>
    api('api/breakdown?' + q({ site: state.site, range: state.range, type: t, limit: 12 })).catch(() => null)));
  const names = { country: '国家 / 地区', browser: '浏览器', os: '操作系统', device: '设备' };
  results.forEach((d, i) => {
    const [t, elId] = types[i];
    const el = $(elId);
    if (!d || !d.items.length) { el.innerHTML = EMPTY; return; }
    el.innerHTML = `<table><thead><tr><th>${names[t]}</th><th class="num">浏览量</th><th class="num">访客数</th></tr></thead>
      <tbody>${d.items.map((x) => `
        <tr><td class="name" title="${escapeHtml(x.name)}">${escapeHtml(displayName(t, x.name))}</td>
        <td class="num">${fmtInt(x.pageviews)}</td><td class="num">${fmtInt(x.visitors)}</td></tr>`).join('')}
      </tbody></table>`;
  });
}

// 实时访客
async function loadRealtime() {
  const d = await api('api/realtime?' + q({ site: state.site }));
  rollNumber($('rt-big'), d.visitors, fmtInt);
  const det = await api('api/realtime-detail?' + q({ site: state.site })).catch(() => null);
  $('rt-urls').innerHTML = det && det.urls.length ? miniList(det.urls) : EMPTY;
  $('rt-refs').innerHTML = det && det.referrers.length
    ? miniList(det.referrers.map((r) => ({ ...r, name: r.name || '直接访问' })), 'referrer') : EMPTY;
  $('rt-countries').innerHTML = det && det.countries.length ? miniList(det.countries, 'country') : EMPTY;
}

// ---------- 视图调度 ----------
const LOADERS = {
  overview: loadOverview,
  traffic: loadTraffic,
  source: loadSource,
  pages: loadPages,
  visitors: loadVisitors,
  realtime: loadRealtime,
};

async function showView(view) {
  state.view = view;
  document.querySelectorAll('#nav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((s) =>
    s.classList.toggle('hidden', s.id !== 'view-' + view));
  resizeCharts();
  try {
    await LOADERS[view]();
  } catch (e) {
    const el = $('view-' + view);
    if (el && !el.querySelector('.card-error')) {
      el.insertAdjacentHTML('afterbegin',
        '<div class="card"><div class="card-error">数据加载失败：' + escapeHtml(e.message) + '</div></div>');
    }
  }
  resizeCharts();
}

function refreshCurrent() {
  showView(state.view).catch((e) => console.error(e));
}

// ---------- 初始化 ----------
async function init() {
  const sites = await api('api/sites');
  state.sites = sites;
  state.site = sites[0]?.name || '';

  const renderSiteSeg = () => buildSeg($('site-seg'), sites,
    (s) => s.name, (s) => s.name, state.site,
    (v) => { state.site = v; renderSiteSeg(); refreshCurrent(); });
  renderSiteSeg();

  $('range-seg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('range-seg').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.range = b.dataset.range;
      refreshCurrent();
    };
  });

  $('nav').querySelectorAll('button').forEach((b) => {
    b.onclick = () => showView(b.dataset.view);
  });
  $('rt-strip').style.cursor = 'pointer';
  $('rt-strip').title = '查看实时访客';
  $('rt-strip').onclick = () => showView('realtime');

  wireTabs($('ov-metric-tabs'), 'm', state.ovMetric, (v) => { state.ovMetric = v; loadOverview().catch((e) => console.error(e)); });
  wireTabs($('tf-metric-tabs'), 'm', state.tfMetric, (v) => { state.tfMetric = v; loadTraffic().catch((e) => console.error(e)); });
  const wireToggle = (id, key, reload) => {
    const el = $(id);
    el.onclick = () => {
      el.classList.toggle('active');
      state[key] = el.classList.contains('active');
      reload().catch((e) => console.error(e));
    };
  };
  wireToggle('ov-compare', 'ovCompare', loadOverview);
  wireToggle('tf-compare', 'tfCompare', loadTraffic);

  buildKpis();
  await showView('overview');

  // 实时轮询：总览只刷在线条，实时页全刷；其余视图不轮询
  setInterval(() => {
    if (state.view === 'overview') loadRealtimeStrip().catch((e) => console.error(e));
    else if (state.view === 'realtime') loadRealtime().catch((e) => console.error(e));
  }, 30000);

  const lb = $('logout-btn');
  if (lb) lb.onclick = async () => { try { await fetch('logout', { method: 'POST' }); } catch (e) {} location.href = 'login.html'; };
  addEventListener('resize', resizeCharts);
}

init().catch((e) => {
  document.querySelector('.app').insertAdjacentHTML('afterbegin',
    '<div class="card"><div class="card-error">初始化失败：' + escapeHtml(e.message) + '</div></div>');
});
