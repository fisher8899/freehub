'use strict';
/**
 * 采集编排：遍历启用的源 → 拉取 → 分类 → 去重入库。
 * config.json 中的 sources 持久化（含 lastRun/lastStatus），数据库只存活动条目。
 */
const crypto = require('node:crypto');
const store = require('./db');
const { classifyType, classifyTier, normalizeDate } = require('./classify');
const { fetchFreeegg } = require('./sources/freeegg');
const { fetchRss } = require('./sources/rss');
const { fetchGithubList } = require('./sources/github');

function makeId(source, sourceId) {
  return crypto.createHash('sha1').update(`${source}::${sourceId}`).digest('hex').slice(0, 24);
}

async function crawlOne(sourceCfg) {
  let raw;
  if (sourceCfg.type === 'freeegg') {
    raw = await fetchFreeegg();
  } else if (sourceCfg.type === 'rss') {
    raw = await fetchRss(sourceCfg.url, sourceCfg.name);
  } else if (sourceCfg.type === 'github') {
    raw = await fetchGithubList(sourceCfg.url);
  } else {
    throw new Error(`未知源类型 ${sourceCfg.type}`);
  }
  let inserted = 0;
  for (const item of raw) {
    const cls = classifyType(item.title, item.summary, item.contentMd);
    const rec = {
      id: makeId(sourceCfg.id, item.sourceId),
      source: sourceCfg.type === 'freeegg' ? 'freeegg' : `${sourceCfg.type}:${sourceCfg.id}`,
      sourceId: item.sourceId,
      vendor: (item.vendor || '未知厂商').trim().slice(0, 60),
      title: item.title.slice(0, 200),
      category: item.category,
      type: cls.type,
      tier: classifyTier(item.score),
      score: item.score,
      duration: item.duration,
      region: item.region,
      summary: (item.summary || '').slice(0, 600),
      contentMd: item.contentMd || '',
      link: item.link,
      publishedAt: normalizeDate(item.publishedAt),
      updatedAt: normalizeDate(item.updatedAt),
      expiresAt: normalizeDate(item.expiresAt),
      expired: !!item.expired,
      sourceName: sourceCfg.name,
    };
    store.upsertActivity(rec);
    inserted++;
  }
  return inserted;
}

let crawling = false;

async function runCrawl(config) {
  if (crawling) return { skipped: true, reason: '已有采集任务在执行' };
  crawling = true;
  global.__freehubCrawling = true;
  const started = new Date().toISOString();
  const results = [];
  try {
    for (const src of config.sources.filter(s => s.enabled && (s.type !== 'rss' || s.url))) {
      const t0 = Date.now();
      try {
        const n = await crawlOne(src);
        src.lastRun = new Date().toISOString();
        src.lastStatus = `ok · ${n} 条 · ${Date.now() - t0}ms`;
        results.push({ id: src.id, ok: true, count: n, ms: Date.now() - t0 });
      } catch (err) {
        src.lastRun = new Date().toISOString();
        src.lastStatus = `失败 · ${err.message}`;
        results.push({ id: src.id, ok: false, error: err.message });
      }
    }
    store.markStaleExpired();
    const total = results.reduce((s, r) => s + (r.count || 0), 0);
    store.setMeta('last_crawl', new Date().toISOString());
    store.setMeta('last_crawl_summary', results.map(r => `${r.id}:${r.ok ? r.count : 'ERR'}`).join(', '));
    return { skipped: false, started, finished: new Date().toISOString(), total, results };
  } finally {
    crawling = false;
    global.__freehubCrawling = false;
  }
}

module.exports = { runCrawl, crawling: () => crawling };
