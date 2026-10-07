// ============================================================
// 网站数据看板 · 后端
// 数据引擎：Umami v3 HTTP API（只用接口，不用 Umami 自带 UI）
// 本服务只做一件事：服务端持有 API Key，代理 Umami 只读接口，
// 把原始数据整理成前端直接可用的形状。Key 绝不暴露给前端。
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');

// ---------- 1. 读取 .env（极简解析，不额外引入 dotenv 依赖） ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

// ---------- 2. 配置 ----------
const UMAMI_API_BASE = (process.env.UMAMI_API_BASE || 'http://127.0.0.1:3000/umami').replace(/\/$/, '');
const UMAMI_API_KEY = process.env.UMAMI_API_KEY || '';
const PORT = Number(process.env.PORT || 3002);

if (!UMAMI_API_KEY) {
  console.warn('[warn] 未配置 UMAMI_API_KEY，/api/* 接口将返回 502，请复制 .env.example 为 .env 并填写');
}

// ---------- 3. 站点清单（与 Umami 后台 Website 一一对应） ----------
// ID 来自 Umami 后台 Settings → Websites；新增站点时在这里加一行即可
const SITES = [
  { id: '0890a1ca-fc8c-4ac1-892f-b379fc4580c9', name: 'wuyu.uk' },
  { id: '9253c109-7093-48a9-8ff0-2a84942fbf7f', name: 'glint.red' },
];

function findSite(name) {
  return SITES.find((s) => s.name === name) || SITES[0];
}

// ---------- 4. 时间范围换算（毫秒时间戳，用户视角按 Asia/Shanghai） ----------
// 上海为 UTC+8 且无夏令时，用"整体平移 8 小时"算出上海墙钟的当天 0 点
function shanghaiDayStart(offsetDays) {
  const shifted = new Date(Date.now() + 8 * 3600e3);
  const dayStartShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - offsetDays,
  );
  return dayStartShifted - 8 * 3600e3;
}

// range: today | yesterday | 7d | 30d
function resolveRange(range) {
  const now = Date.now();
  switch (range) {
    case 'yesterday': {
      const s = shanghaiDayStart(1);
      return { start: s, end: s + 86400e3 };
    }
    case '7d':
      return { start: shanghaiDayStart(6), end: now };
    case '30d':
      return { start: shanghaiDayStart(29), end: now };
    case 'today':
    default:
      return { start: shanghaiDayStart(0), end: now };
  }
}

// ---------- 5. Umami 请求封装 ----------
// 鉴权假设（见 README）：同时发送 Authorization: Bearer 与 x-umami-api-key，
// 兼容 v3 的登录 token 与 API Key 两种形态；若上游鉴权变更，以 Umami 官方文档为准
async function umami(apiPath, params = {}) {
  if (!UMAMI_API_KEY) {
    const e = new Error('未配置 UMAMI_API_KEY');
    e.code = 'NO_KEY';
    throw e;
  }
  const url = new URL(`${UMAMI_API_BASE}/api${apiPath}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${UMAMI_API_KEY}`,
        'x-umami-api-key': UMAMI_API_KEY,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`Umami 不可达：${e.message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Umami 接口 ${res.status}：${apiPath} ${body}`);
  }
  return res.json();
}

// 数字兜底：非数字一律按 0 处理，保证接口形状稳定
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 环比：返回小数（如 0.12 = +12%）；上期为 0 时返回 null（前端显示"—"）
function pctChange(cur, prev) {
  if (prev > 0) return (cur - prev) / prev;
  return null;
}

// ---------- 6. Express 应用 ----------
const app = express();

// 健康检查（给 systemd / nginx 用）
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// 站点清单
app.get('/api/sites', (_req, res) => {
  res.json(SITES.map((s) => ({ id: s.id, name: s.name })));
});

// 总览：KPI + 环比（与上一周期对比）
app.get('/api/overview', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const { start, end } = resolveRange(req.query.range);
    const dur = end - start;

    // 当前周期与上一周期并行取数
    const [cur, prev] = await Promise.all([
      umami(`/websites/${site.id}/stats`, { startAt: start, endAt: end }),
      umami(`/websites/${site.id}/stats`, { startAt: start - dur, endAt: start }),
    ]);

    const visitors = num(cur.visitors);
    const visits = num(cur.visits);
    const pageviews = num(cur.pageviews);
    const bounces = num(cur.bounces);
    const totaltime = num(cur.totaltime);

    const bounceRate = visits > 0 ? bounces / visits : 0; // 跳出率（小数）
    const avgDuration = visits > 0 ? totaltime / visits : 0; // 平均停留（秒）
    const prevBounceRate = num(prev.visits) > 0 ? num(prev.bounces) / num(prev.visits) : 0;

    res.json({
      site: site.name,
      visitors,
      visits,
      pageviews,
      bounces,
      bounceRate,
      avgDuration,
      prev: {
        visitors: num(prev.visitors),
        visits: num(prev.visits),
        pageviews: num(prev.pageviews),
      },
      delta: {
        visitors: pctChange(visitors, num(prev.visitors)),
        visits: pctChange(visits, num(prev.visits)),
        pageviews: pctChange(pageviews, num(prev.pageviews)),
        bounceRate: bounceRate - prevBounceRate, // 百分点变化
      },
      updatedAt: Date.now(),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- 趋势数据抓取（抽出复用）----------
// 合并 pageviews + sessions 为统一时间点序列；x 为毫秒时间戳
function parseBucket(x) {
  if (typeof x === 'number') return x;
  if (typeof x !== 'string' || x.length === 0) return 0;
  const s = /[zZ]|[+-][0-9][0-9]:?[0-9][0-9]$/.test(x) ? x : x + '+08:00';
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

function mergePvSe(pvArr, seArr) {
  const byTime = new Map();
  const put = (arr, key) => {
    for (const p of (Array.isArray(arr) ? arr : [])) {
      const t = parseBucket(p.x);
      if (!byTime.has(t)) byTime.set(t, { t, pageviews: 0, visits: 0 });
      byTime.get(t)[key] = num(p.y);
    }
  };
  put(pvArr, 'pageviews');
  put(seArr, 'visits');
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

async function getPageviews(websiteId, start, end, unit) {
  const data = await umami(`/websites/${websiteId}/pageviews`, { startAt: start, endAt: end, unit, timezone: 'Asia/Shanghai' });
  // 兼容多种返回形状
  const pvArr = Array.isArray(data?.pageviews) ? data.pageviews
    : Array.isArray(data) ? data : [];
  const seArr = Array.isArray(data?.sessions) ? data.sessions : [];
  return mergePvSe(pvArr, seArr);
}

// 从 compare=prev 返回里防御性提取上期序列（Umami 各版本键名不一，多候选；提不出返回 null）
function extractPrevSeries(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let pv = null, se = null;
  for (const k of ['pageviews_prev', 'pageviewsPrev', 'prev_pageviews']) {
    if (Array.isArray(raw[k])) { pv = raw[k]; break; }
  }
  for (const k of ['sessions_prev', 'sessionsPrev', 'prev_sessions']) {
    if (Array.isArray(raw[k])) { se = raw[k]; break; }
  }
  for (const k of ['compare', 'prev', 'previous', 'comparison']) {
    const o = raw[k];
    if (o && typeof o === 'object') {
      if (!pv && Array.isArray(o.pageviews)) pv = o.pageviews;
      if (!se && Array.isArray(o.sessions)) se = o.sessions;
    }
  }
  if (!pv && !se) return null;
  const pts = mergePvSe(pv || [], se || []);
  return pts.length ? pts : null;
}

// 趋势：按小时（今日/昨日）或按天（近7/30天）；?compare=prev 时附带上期序列（虚线对比用）
app.get('/api/trend', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const range = req.query.range || 'today';
    const { start, end } = resolveRange(range);
    const unit = range === '7d' || range === '30d' ? 'day' : 'hour';

    const points = await getPageviews(site.id, start, end, unit);

    let prevPoints = null;
    if (req.query.compare === 'prev') {
      const dur = end - start;
      try {
        // 先试 Umami 原生 compare=prev
        const raw = await umami(`/websites/${site.id}/pageviews`,
          { startAt: start, endAt: end, unit, compare: 'prev' });
        prevPoints = extractPrevSeries(raw);
      } catch { /* 键名对不上就走回退 */ }
      if (!prevPoints) {
        // 回退：单独拉上一周期再拼（/pageviews 已验证可用，必定成功）
        try { prevPoints = await getPageviews(site.id, start - dur, end - dur, unit); }
        catch { prevPoints = null; }
      }
    }

    res.json({ site: site.name, unit, points, prevPoints, updatedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- 渠道分组规则（百度统计式：直接访问 / 搜索引擎 / 社交媒体 / 外部链接）----------
const SEARCH_ENGINES = [
  { name: '百度', hosts: ['baidu.com'] },
  { name: 'Google', hosts: ['google.'] },
  { name: 'Bing', hosts: ['bing.com'] },
  { name: '搜狗', hosts: ['sogou.com'] },
  { name: '360搜索', hosts: ['so.com', '360.cn', '360.com'] },
  { name: 'DuckDuckGo', hosts: ['duckduckgo.com'] },
  { name: 'Yandex', hosts: ['yandex.'] },
];
const SOCIAL_HOSTS = ['weibo.', 'weixin.', 'qq.com', 'xiaohongshu.', 'douyin.', 'zhihu.',
  'douban.', 'bilibili.', 'tieba.', 'twitter.', 'x.com', 'facebook.', 'instagram.',
  'threads.', 'youtube.', 't.me', 'telegram.', 'linkedin.'];
const CHANNEL_ORDER = ['直接访问', '搜索引擎', '社交媒体', '外部链接'];

function hostnameOf(ref) {
  const s = String(ref || '').trim().toLowerCase();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : 'https://' + s);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return s.split('/')[0].replace(/^www\./, '');
  }
}
function engineOf(host) {
  for (const e of SEARCH_ENGINES) {
    if (e.hosts.some((h) => host.includes(h))) return e.name;
  }
  return '';
}
function channelOf(host) {
  if (!host) return '直接访问';
  if (engineOf(host)) return '搜索引擎';
  if (SOCIAL_HOSTS.some((h) => host.includes(h))) return '社交媒体';
  return '外部链接';
}

// 抓取 metrics 明细（expanded 优先，失败回退普通；统一做数组归一化）
async function fetchMetrics(websiteId, type, start, end) {
  let rows;
  try {
    rows = await umami(`/websites/${websiteId}/metrics/expanded`, { startAt: start, endAt: end, type });
  } catch {
    rows = await umami(`/websites/${websiteId}/metrics`, { startAt: start, endAt: end, type });
  }
  return Array.isArray(rows) ? rows : (Array.isArray(rows?.data) ? rows.data : []);
}

// 明细：热门页面 / 来源 / 浏览器 / 系统 / 设备 / 国家（?limit= 取前 N，默认 10，上限 50）
const BREAKDOWN_TYPES = { url: 'path', referrer: 'referrer', browser: 'browser', os: 'os', device: 'device', country: 'country' };

app.get('/api/breakdown', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const type = BREAKDOWN_TYPES[req.query.type] || 'path';
    const { start, end } = resolveRange(req.query.range);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const rows = await fetchMetrics(site.id, type, start, end);
    const items = rows.slice(0, limit).map((r) => ({
      name: String(r.name ?? r.x ?? ''), // v3 expanded 维度值在 name 字段
      pageviews: num(r.pageviews ?? r.y), // expanded 有 pageviews 字段；普通 metrics 只有 y
      visitors: num(r.visitors),
    }));
    res.json({ site: site.name, type: req.query.type || 'url', items, updatedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 实时：近 5 分钟在线访客数
// 假设：/active 返回 { visitors: 数字 }；若返回数组则按长度计
app.get('/api/realtime', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const data = await umami(`/websites/${site.id}/active`);
    const visitors = typeof data?.visitors === 'number' ? data.visitors
      : Array.isArray(data) ? data.length
      : num(data?.count);
    res.json({ site: site.name, visitors, updatedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- v2 新增：来源分析 ----------
// 渠道构成（环形图）+ 来源域名 Top15 + 搜索引擎 Top10，一次取齐
app.get('/api/channel', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const { start, end } = resolveRange(req.query.range);
    const [rows, totals] = await Promise.all([
      fetchMetrics(site.id, 'referrer', start, end),
      umami(`/websites/${site.id}/stats`, { startAt: start, endAt: end }),
    ]);

    const chMap = new Map(CHANNEL_ORDER.map((c) => [c, { channel: c, visitors: 0, pageviews: 0 }]));
    const domMap = new Map();
    const engMap = new Map();
    let refV = 0, refP = 0;
    for (const r of rows) {
      const host = hostnameOf(r.name ?? r.x);
      const ch = channelOf(host);
      const pv = num(r.pageviews ?? r.y);
      const vs = num(r.visitors);
      const c = chMap.get(ch);
      c.visitors += vs; c.pageviews += pv;
      refV += vs; refP += pv;
      const dk = host || '直接访问';
      if (!domMap.has(dk)) domMap.set(dk, { name: host || '直接访问', visitors: 0, pageviews: 0 });
      const d = domMap.get(dk);
      d.visitors += vs; d.pageviews += pv;
      const eng = engineOf(host);
      if (eng) {
        if (!engMap.has(eng)) engMap.set(eng, { name: eng, visitors: 0, pageviews: 0 });
        const e = engMap.get(eng);
        e.visitors += vs; e.pageviews += pv;
      }
    }
    // 直接访问 = 总量 − 有来源部分（Umami 不为直接访问产生来源行）
    const directV = Math.max(num(totals.visitors) - refV, 0);
    const directP = Math.max(num(totals.pageviews) - refP, 0);
    const dc = chMap.get('直接访问'); dc.visitors += directV; dc.pageviews += directP;
    if (!domMap.has('直接访问')) domMap.set('直接访问', { name: '直接访问', visitors: 0, pageviews: 0 });
    const dd = domMap.get('直接访问'); dd.visitors += directV; dd.pageviews += directP;
    const byPv = (a, b) => b.pageviews - a.pageviews;
    res.json({
      site: site.name,
      channels: [...chMap.values()],
      domains: [...domMap.values()].sort(byPv).slice(0, 15),
      engines: [...engMap.values()].sort(byPv).slice(0, 10),
      updatedAt: Date.now(),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- v2 新增：24 小时分布（仅今日 / 昨日，按上海墙钟小时聚合）----------
app.get('/api/hourly', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const range = req.query.range || 'today';
    if (range !== 'today' && range !== 'yesterday') {
      return res.json({ site: site.name, hours: [], updatedAt: Date.now() });
    }
    const { start, end } = resolveRange(range);
    const pts = await getPageviews(site.id, start, end, 'hour');
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, pageviews: 0, visits: 0 }));
    for (const p of pts) {
      const h = new Date(p.t + 8 * 3600e3).getUTCHours(); // 上海墙钟小时
      if (h >= 0 && h < 24) {
        hours[h].pageviews += p.pageviews;
        hours[h].visits += p.visits;
      }
    }
    res.json({ site: site.name, hours, updatedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- v2 新增：受访页面 Top20 ----------
app.get('/api/pages', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const { start, end } = resolveRange(req.query.range);
    const rows = await fetchMetrics(site.id, 'title', start, end);
    const items = rows
      .map((r) => ({
        name: String(r.name ?? r.x ?? ''), // v3 expanded 维度值在 name 字段
        pageviews: num(r.pageviews ?? r.y),
        visitors: num(r.visitors),
      }))
      .filter((it) => it.name && /[.](css|js|png|jpg|svg|ico|woff2)$/i.test(it.name) === false)
      .slice(0, 20);
    res.json({ site: site.name, items, updatedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- v2 新增：实时明细（最近 30 分钟的页面 / 来源 / 国家）----------
// GET /api/realtime/{websiteId} 形状不确定，尽力解析；404 或失败一律返回空数组，前端显示"暂无数据"
app.get('/api/realtime-detail', async (req, res) => {
  const site = findSite(req.query.site);
  const empty = { site: site.name, urls: [], referrers: [], countries: [], updatedAt: Date.now() };
  try {
    const data = await umami(`/realtime/${site.id}`);
    const norm = (val) => {
      const arr = Array.isArray(val) ? val
        : (val && typeof val === 'object')
          ? Object.entries(val).map(([name, count]) => ({ name, count }))
          : [];
      return arr.slice(0, 10).map((r) => ({
        name: String(r.name ?? r.x ?? r.url ?? ''),
        count: num(r.count ?? r.y ?? r.visitors ?? r.pageviews),
      })).filter((r) => r.name);
    };
    const pick = (...keys) => {
      for (const k of keys) {
        const v = data?.[k];
        if (Array.isArray(v) || (v && typeof v === 'object')) return v;
      }
      return [];
    };
    res.json({
      site: site.name,
      urls: norm(pick('urls', 'pages', 'topPages')),
      referrers: norm(pick('referrers', 'sources', 'topReferrers')),
      countries: norm(pick('countries', 'topCountries')),
      updatedAt: Date.now(),
    });
  } catch {
    res.json(empty);
  }
});

// ---------- 7. 静态前端 ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[ok] 看板后端监听 127.0.0.1:${PORT}，Umami 基址 ${UMAMI_API_BASE}`);
});
