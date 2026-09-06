'use strict';
/**
 * freehub —— 免费 Token / 模型体验活动情报站
 * HTTP 服务：静态 UI + JSON API + 定时采集（零 npm 依赖，Node ≥ 22.5）
 *
 *   node server/index.js                → http://127.0.0.1:8619
 *   FREEHUB_PORT=9000 node server/index.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const WEB_DIR = path.join(ROOT, 'web');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DB_FILE = path.join(DATA_DIR, 'freehub.db');

const store = require('./db');
const { classifyType, classifyTier } = require('./classify');
const { runCrawl } = require('./collector');

/* ---------------- 配置 ---------------- */
function defaultConfig() {
  return {
    port: 8619,
    crawlIntervalHours: 6,   // 自动采集间隔
    defaultWindowDays: 14,   // 默认时间窗（最近 2 周）
    newDays: 7,              // 「NEW」标记阈值
    sources: [
      { id: 'freeegg', type: 'freeegg', name: 'FreeEgg 赛博鸡蛋（主源）',
        url: 'https://freeegg.top/data/eggs.json', enabled: true },
      { id: 'github-free-llm', type: 'github', name: 'GitHub 免费 LLM 清单',
        url: 'https://raw.githubusercontent.com/jtig37/free-llm-api-resources/main/README.md', enabled: false },
      { id: 'rss-slot-1', type: 'rss', name: '微信公众号 RSS（示例槽位，请替换为你的 feed）',
        url: '', enabled: false },
    ],
  };
}
function loadConfig() {
  try {
    return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
const config = loadConfig();

/* ---------------- 数据库 ---------------- */
store.open(DB_FILE);

/* ---------------- 工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname, query) {
  const method = req.method;

  if (method === 'GET' && pathname === '/api/activities') {
    const rows = store.queryActivities({
      q: query.get('q') || '',
      type: query.get('type') || '',
      tier: query.get('tier') || '',
      vendor: query.get('vendor') || '',
      sort: query.get('sort') || 'time',
      includeExpired: query.get('includeExpired') === '1',
      windowDays: query.get('window') === 'all' ? 0 : (Number(query.get('window')) || config.defaultWindowDays),
    });
    return json(res, 200, { items: rows, newDays: config.newDays, now: new Date().toISOString() });
  }

  if (method === 'GET' && pathname === '/api/vendors') return json(res, 200, { vendors: store.listVendors() });
  if (method === 'GET' && pathname === '/api/stats') return json(res, 200, store.stats());

  if (method === 'POST' && pathname === '/api/crawl') {
    const result = await runCrawl(config);
    saveConfig(config); // 持久化 lastRun/lastStatus
    return json(res, 200, result);
  }

  if (method === 'GET' && pathname === '/api/sources') {
    return json(res, 200, {
      sources: config.sources,
      crawlIntervalHours: config.crawlIntervalHours,
      lastCrawl: store.getMeta('last_crawl'),
      lastSummary: store.getMeta('last_crawl_summary'),
    });
  }

  if (method === 'POST' && pathname === '/api/sources') {
    const body = await readBody(req);
    const type = String(body.type || 'rss');
    const url = String(body.url || '').trim();
    if (!['rss', 'github', 'freeegg'].includes(type)) return json(res, 400, { error: 'type 必须是 rss/github/freeegg' });
    if (!url.startsWith('http')) return json(res, 400, { error: '请填写 http(s) 地址' });
    const src = {
      id: `${type}-${Date.now().toString(36)}`,
      type, url,
      name: String(body.name || '').trim() || `新源 ${type}`,
      enabled: true,
    };
    config.sources.push(src);
    saveConfig(config);
    return json(res, 200, { source: src });
  }

  const srcToggle = pathname.match(/^\/api\/sources\/([^/]+)\/(toggle|delete)$/);
  if (srcToggle) {
    const idx = config.sources.findIndex(s => s.id === decodeURIComponent(srcToggle[1]));
    if (idx < 0) return json(res, 404, { error: '源不存在' });
    if (srcToggle[2] === 'toggle') {
      config.sources[idx].enabled = !config.sources[idx].enabled;
    } else {
      if (config.sources[idx].type === 'freeegg') return json(res, 400, { error: '主源不可删除' });
      config.sources.splice(idx, 1);
    }
    saveConfig(config);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/activities/manual') {
    const b = await readBody(req);
    const title = String(b.title || '').trim();
    if (!title) return json(res, 400, { error: '标题必填' });
    const vendor = String(b.vendor || '').trim() || '手动添加';
    const summary = String(b.summary || '').trim();
    const content = String(b.content || '').trim();
    const cls = classifyType(title, summary, content);
    const now = new Date().toISOString();
    const rec = {
      id: crypto.createHash('sha1').update(`manual::${vendor}::${title}::${now}`).digest('hex').slice(0, 24),
      source: 'manual', sourceId: title,
      vendor: vendor.slice(0, 60), title: title.slice(0, 200),
      category: null,
      type: ['signup', 'daily', 'login', 'free', 'limited'].includes(b.type) ? b.type : cls.type,
      tier: classifyTier(Number(b.score) || 60),
      score: Number(b.score) || 60,
      duration: null, region: null,
      summary, contentMd: content, link: String(b.link || '').trim(),
      publishedAt: now, updatedAt: now,
      expiresAt: b.expiresAt || null, expired: false, sourceName: '手动添加',
    };
    store.upsertActivity(rec);
    return json(res, 200, { ok: true, id: rec.id });
  }

  const delAct = pathname.match(/^\/api\/activities\/([0-9a-f]+)$/);
  if (method === 'DELETE' && delAct) {
    store._db().prepare('DELETE FROM activities WHERE id = ?').run(delAct[1]);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
}

/* ---------------- 定时采集 ---------------- */
const CRAWL_CHECK_MS = 10 * 60 * 1000;
function crawlIfDue() {
  const last = store.getMeta('last_crawl');
  const due = !last || (Date.now() - new Date(last).getTime()) > config.crawlIntervalHours * 3600 * 1000;
  if (!due) return;
  console.log(`[freehub] 定时采集开始（上次：${last || '从未'}）`);
  runCrawl(config)
    .then(r => saveConfig(config))
    .then(() => console.log('[freehub] 定时采集完成'))
    .catch(e => console.error('[freehub] 定时采集失败：', e.message));
}

/* ---------------- Server ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u.pathname, u.searchParams);
    return serveStatic(req, res, u.pathname);
  } catch (err) {
    console.error('[freehub] 请求处理失败：', err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

const PORT = Number(process.env.FREEHUB_PORT) || config.port;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[freehub] 免费 Token 情报站已启动 → http://127.0.0.1:${PORT}`);
  console.log(`[freehub] 数据库：${DB_FILE}`);
  console.log(`[freehub] 采集间隔：${config.crawlIntervalHours} 小时 · 启用源：${config.sources.filter(s => s.enabled).map(s => s.id).join(', ')}`);
  setImmediate(crawlIfDue);                       // 启动即检查是否需要采集
  setInterval(crawlIfDue, CRAWL_CHECK_MS).unref(); // 之后每 10 分钟检查一次到期
});
