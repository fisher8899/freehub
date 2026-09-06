# FreeHub · 免费 Token 情报站

聚合各大 AI 厂商「送 Token / 免费用模型」福利活动的本机情报站：自动定时拉取最近活动、
按**供应商**分组、按**获取方式**（注册送 / 每日打卡送 / 登录即领 / 限时体验 / 长期免费）分类，
让你第一时间知道去哪领、怎么领。

```
node server/index.js        # Node ≥ 22.5，零 npm 依赖
```

打开 <http://127.0.0.1:8619>。Windows 下直接双击 `start.bat`。

## 功能

- **多源采集**（可插拔，见下方数据源）
- **自动分类**：关键词打分引擎识别 `注册送` / `每日打卡送` / `登录即领` / `限时体验` / `长期免费`
- **等级分层**：按福利分映射 金蛋(≥80) / 银蛋(≥60) / 铜蛋，对应 FreeEgg 的 `tier=gold,silver,copper`
- **定时采集**：默认每 6 小时，启动时自动补跑；UI 上可「立即刷新」
- **时间窗**：默认只展示**最近 2 周**有动静的活动，可切 7 / 30 天 / 全部
- **管理**：添加 RSS 源（微信公众号桥接）、手动收录活动、开关/删除源、删除单条

## 数据源

| 源 | 说明 | 默认 |
| --- | --- | --- |
| FreeEgg 赛博鸡蛋 | 主源，直接读取 <https://freeegg.top/data/eggs.json>（该站为纯静态数据） | 启用 |
| GitHub 免费 LLM 清单 | `jtig37/free-llm-api-resources` raw README（英文资源为主） | 关闭 |
| RSS / Atom（自定义） | 微信公众号转 RSS（如 [wechat2rss.xlab.app](https://wechat2rss.xlab.app)、feeddd 等桥接服务）、厂商官方博客 RSS、GitHub Releases Atom | 关闭 |

**接微信公众号**：公众号没有官方 RSS，需借助桥接服务把「XX 公众号」转成 feed URL，
然后在 UI「⚙ 管理 → 数据源 → 添加新源」粘贴即可。条目会按福利关键词
（免费/送/领取/体验/试用/签到/注册/积分/额度/公测/内测…）自动过滤，供应商名取自源名称。

源配置与状态持久化在 `data/config.json`，条目数据在 `data/freehub.db`（SQLite）。

## 分类规则（server/classify.js）

对标题(×3)、摘要(×2)、正文(×1) 做关键词打分取最高：

| 类型 | 命中示例 |
| --- | --- |
| 📅 每日打卡送 | 每日/每天/签到/打卡/连续登录 |
| 🎁 注册送 | 注册/新用户/新人礼/首次登录/开服 |
| ⏳ 限时体验 | 限时/公测/内测/体验/试用/活动/周末/开学/周年/红包/学生 |
| 🆓 长期免费 | 永久免费/免费模型/免费调用/免费额度/免费 API |
| 👉 登录即领 | 登录即领/免费领取/白嫖/赠送 |

## API

```
GET  /api/activities?q=&type=&tier=&vendor=&window=14|7|30|all&sort=time|score&includeExpired=1
GET  /api/vendors                       # 供应商聚合
GET  /api/stats                         # 统计
POST /api/crawl                         # 立即采集全部启用源
GET  /api/sources                       # 源列表（含最近采集状态）
POST /api/sources                       # {type,name,url} 添加源
POST /api/sources/<id>/toggle           # 启用/停用
POST /api/sources/<id>/delete           # 删除
POST /api/activities/manual             # 手动收录 {vendor,title,summary,content,link,type,expiresAt}
DELETE /api/activities/<id>             # 删除单条
```

## 配置（data/config.json）

```json
{
  "port": 8619,                // 或环境变量 FREEHUB_PORT
  "crawlIntervalHours": 6,     // 自动采集间隔
  "defaultWindowDays": 14,     // 默认时间窗（最近 2 周）
  "newDays": 7                 // 「NEW」徽章阈值
}
```

## 目录结构

```
server/
  index.js       HTTP 服务 + API + 定时调度
  db.js          SQLite 存储（node:sqlite，零依赖）
  collector.js   采集编排（去重入库、源状态记录）
  classify.js    类型/等级分类引擎
  sources/       freeegg / rss / github 采集器
web/             前端（原生 JS 零依赖）
data/            config.json（源配置）+ freehub.db（数据）
```

## 说明

- 本服务只聚合公开的活动信息，落地页均为各厂商官方页面；领取需按官方指引注册/登录。
- 请遵守各平台服务条款，勿自动化滥用。
