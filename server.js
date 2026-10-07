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

// 趋势：按小时（今日/昨日）或按天（近7/30天）
// 假设：/pageviews 返回 { pageviews:[{x,y}], sessions:[{x,y}] }，x 为毫秒时间戳
app.get('/api/trend', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const range = req.query.range || 'today';
    const { start, end } = resolveRange(range);
    const unit = range === '7d' || range === '30d' ? 'day' : 'hour';

    const data = await umami(`/websites/${site.id}/pageviews`, { startAt: start, endAt: end, unit });

    // 兼容多种返回形状
    const pvArr = Array.isArray(data?.pageviews) ? data.pageviews
      : Array.isArray(data) ? data : [];
    const seArr = Array.isArray(data?.sessions) ? data.sessions : [];

    const byTime = new Map();
    for (const p of pvArr) {
      const t = num(p.x);
      if (!byTime.has(t)) byTime.set(t, { t, pageviews: 0, visits: 0 });
      byTime.get(t).pageviews = num(p.y);
    }
    for (const s of seArr) {
      const t = num(s.x);
      if (!byTime.has(t)) byTime.set(t, { t, pageviews: 0, visits: 0 });
      byTime.get(t).visits = num(s.y);
    }

    const points = [...byTime.values()].sort((a, b) => a.t - b.t);
    res.json({ site: site.name, unit, points, updatedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 明细：热门页面 / 来源 / 浏览器 / 系统 / 设备 / 国家（前 10）
// 优先用 /metrics/expanded（每行带 pageviews + visitors），失败则回退到 /metrics
const BREAKDOWN_TYPES = { url: 'path', referrer: 'referrer', browser: 'browser', os: 'os', device: 'device', country: 'country' };

app.get('/api/breakdown', async (req, res) => {
  try {
    const site = findSite(req.query.site);
    const type = BREAKDOWN_TYPES[req.query.type] || 'path';
    const { start, end } = resolveRange(req.query.range);

    let rows;
    try {
      rows = await umami(`/websites/${site.id}/metrics/expanded`, { startAt: start, endAt: end, type });
    } catch {
      rows = await umami(`/websites/${site.id}/metrics`, { startAt: start, endAt: end, type });
    }
    const arr = Array.isArray(rows) ? rows : Array.isArray(rows?.data) ? rows.data : [];

    const items = arr.slice(0, 10).map((r) => ({
      name: String(r.x ?? ''),
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

// ---------- 7. 静态前端 ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[ok] 看板后端监听 127.0.0.1:${PORT}，Umami 基址 ${UMAMI_API_BASE}`);
});
