'use strict';
/**
 * 静态导出：采集 → 导出 dist/（web 静态文件 + data/activities.json）
 * 供 GitHub Pages 等纯静态免费空间使用：
 *   node server/export.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DIST = path.join(ROOT, 'dist');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const store = require('./db');
const { runCrawl } = require('./collector');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { sources: [] }; }
}
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const config = loadConfig();
  store.open(path.join(DATA_DIR, 'freehub.db'));

  console.log('[export] 采集全部启用源…');
  const crawl = await runCrawl(config);
  for (const r of crawl.results || []) {
    console.log(`  ${r.id}: ${r.ok ? 'ok ' + r.count + ' 条' : '失败 ' + r.error}`);
  }

  const rows = store.queryActivities({ windowDays: 0, includeExpired: true, sort: 'time' });
  const payload = {
    generatedAt: new Date().toISOString(),
    newDays: config.newDays || 7,
    items: rows,
    stats: store.stats(),
    vendors: store.listVendors(),
  };

  copyDir(path.join(ROOT, 'web'), DIST);
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'data', 'activities.json'), JSON.stringify(payload), 'utf8');
  console.log(`[export] 完成：dist/data/activities.json（${rows.length} 条）→ 部署 dist/ 即可`);
}

main().catch(err => { console.error('[export] 失败：', err); process.exit(1); });
