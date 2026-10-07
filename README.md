# 网站数据看板（site-stats-board）

中文网站数据看板 Web 应用，一屏看两个站（wuyu.uk / glint.red）的访问数据。

- **数据引擎**：已部署的 Umami v3，只调用它的 HTTP 只读 API，不用它自带的英文 UI
- **后端**：Node.js + Express，跑在 `127.0.0.1:3002`，服务端持有 Umami API Key 做代理（Key 只在服务端 `.env`，绝不进前端）
- **前端**：单页，站点切换 / 时间范围 / KPI / 趋势图 / 明细表 / 实时在线
- **设计语言**：BoardUI（浅灰底、白色 16px 圆角卡片、Inter + JetBrains Mono）；图表走 Lieflat Glance 单色语法；KPI 数字滚动取自 beUI 的 Number Animation 思路

## 文件结构

```
site-stats-board/
├── server.js            # 后端：Express + Umami API 代理（中文注释）
├── package.json         # 唯一依赖：express
├── .env.example         # 配置模板（照抄成 .env 后填真实 Key）
├── .gitignore           # 已忽略 .env / node_modules
├── README.md
└── public/
    ├── index.html       # 页面骨架（全中文）
    ├── app.js           # 前端逻辑
    ├── style.css        # BoardUI token 样式
    └── vendor/
        └── echarts.min.js  # ECharts 6.1.0（本地 vendor，不依赖 CDN）
```

## 本地运行

```bash
npm install
cp .env.example .env   # 然后把 UMAMI_API_KEY 填上
node server.js
# 打开 http://127.0.0.1:3002
```

## 服务器部署

```bash
# 1. 拉代码、装依赖
git clone git@github.com:youfei0719/site-stats-board.git /opt/site-stats-board
cd /opt/site-stats-board && npm install --omit=dev

# 2. 配置（UMAMI_API_KEY 在 Umami 后台 Settings → API Keys 创建，只读即可）
cp .env.example .env
vim .env

# 3. systemd 常驻（/etc/systemd/system/site-stats-board.service）
```

```ini
[Unit]
Description=Site Stats Board
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/site-stats-board
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now site-stats-board
```

### nginx 反代示例（如需公网访问，建议套一层认证或内网限制）

```nginx
location /board/ {
    proxy_pass http://127.0.0.1:3002/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 后端接口（供前端用）

| 接口 | 说明 |
|---|---|
| `GET /api/sites` | 站点清单 `[{id, name}]` |
| `GET /api/overview?site=&range=today\|yesterday\|7d\|30d` | KPI + 环比（含上一周期数值 `prev`） |
| `GET /api/trend?site=&range=` | 趋势点 `[{t, pageviews, visits}]`（今日/昨日按小时，近7/30天按天）；`&compare=prev` 附带上期序列 `prevPoints`（先试 Umami 原生 compare=prev，失败回退为单独拉上一周期） |
| `GET /api/breakdown?site=&type=url\|referrer\|browser\|os\|device\|country&range=` | 明细 `[{name, pageviews, visitors}]`（`&limit=N` 取前 N，默认 10，上限 50） |
| `GET /api/realtime?site=` | 近 5 分钟在线访客数 |
| `GET /api/channel?site=&range=` | 来源分析：`{channels:[{channel,visitors,pageviews}]}`（直接访问/搜索引擎/社交媒体/外部链接）＋ `domains`（来源域名 Top15）＋ `engines`（搜索引擎 Top10） |
| `GET /api/hourly?site=&range=today\|yesterday` | 24 小时分布 `[{hour, pageviews, visits}]`（上海墙钟小时；其他 range 返回空数组） |
| `GET /api/pages?site=&range=` | 受访页面 Top20 `[{name, pageviews, visitors}]` |
| `GET /api/realtime-detail?site=` | 实时明细 `{urls, referrers, countries}`（各 Top10；上游 404/失败时返回空数组，前端显示"暂无数据"） |

时间范围按 **Asia/Shanghai** 换算成毫秒时间戳；环比取等长上一周期对比。
上游（Umami）失败时接口返回 `502 + {error}`，前端如实展示"数据加载失败"，不编造。

## API 假设清单（Umami 官方文档为准）

以下来自 [Umami 官方 API 文档](https://github.com/umami-software/docs/blob/HEAD/content/docs/api/common-endpoints.mdx)
及代码里的防御性解析；若将来 Umami 改版，先核对这里：

1. **鉴权**：同时发送 `Authorization: Bearer <key>` 与 `x-umami-api-key: <key>`。
   官方文档示例用 Bearer（self-host 走 `/api/auth/login` 换 token，Cloud 直接用 API Key 当 Bearer）；
   双 header 是兼容两种形态的兜底，若鉴权失败请先看 Umami 版本文档。
2. **API 基址**：`UMAMI_API_BASE` 默认 `http://127.0.0.1:3000/umami`，
   即"实例地址 + BASE_PATH + /api"。BASE_PATH 部署时必须带 `/umami` 前缀。
3. **`GET /api/websites/{id}/stats?startAt=&endAt=`**（毫秒）→
   `{pageviews, visitors, visits, bounces, totaltime}`（实测文档示例为平铺数字）。
4. **`GET /api/websites/{id}/pageviews?startAt=&endAt=&unit=`** →
   假设返回 `{pageviews:[{x,y}], sessions:[{x,y}]}`（x=毫秒时间戳）；unit 取 `hour`/`day`。
5. **`GET /api/websites/{id}/metrics/expanded?type=`** → 假设每行含 `x`（名称）、
   `pageviews`、`visitors`；失败时回退到 `/metrics`（只有 `x`/`y`，visitors 记 0）。
   `type` 取值：`path`（前端 `url` 参数自动映射）、`referrer`、`browser`、`os`、`device`、`country`。
6. **`GET /api/websites/{id}/active`** → 假设返回 `{visitors: 数字}`（近 5 分钟）；
   若返回数组则按长度计。

## 安全

- 仓库里**不许出现**真实 API Key / 密码：`.env` 已被 `.gitignore` 忽略，
  真实配置只放在服务器 `/opt/site-stats-board/.env`（建议 `chmod 600`）。
- 对外发布前，建议给看板入口加一层访问控制（nginx basic auth / 内网 IP 限制）。
