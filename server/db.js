'use strict';
/**
 * freehub 数据存储层 —— node:sqlite（Node ≥ 22.5 内置，零依赖）
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

let db = null;

function open(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS activities (
      id            TEXT PRIMARY KEY,          -- sha1(source + source_id/link)
      source        TEXT NOT NULL,             -- freeegg / rss:<id> / github:<id> / manual
      source_id     TEXT NOT NULL,
      vendor        TEXT NOT NULL,             -- 供应商（分组用）
      title         TEXT NOT NULL,
      category      TEXT,                      -- 原始分类（token/api-quota/credits/…）
      type          TEXT NOT NULL,             -- signup/daily/login/free/limited
      tier          TEXT NOT NULL,             -- gold/silver/copper
      score         INTEGER DEFAULT 0,
      duration      TEXT,                      -- limited/longterm
      region        TEXT,                      -- cn/global
      summary       TEXT,
      content_md    TEXT,                      -- markdown 领取攻略
      link          TEXT,
      published_at  TEXT,                      -- 活动/文章发布时间 (ISO)
      updated_at    TEXT,
      expires_at    TEXT,                      -- 截止时间 (ISO)
      expired       INTEGER DEFAULT 0,
      first_seen    TEXT NOT NULL,             -- 本库首次发现时间
      last_seen     TEXT NOT NULL,             -- 最近一次采集确认仍在的时间
      source_name   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activities_vendor ON activities(vendor);
    CREATE INDEX IF NOT EXISTS idx_activities_type   ON activities(type);
    CREATE INDEX IF NOT EXISTS idx_activities_seen   ON activities(first_seen);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

function upsertActivity(a) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO activities (id, source, source_id, vendor, title, category, type, tier, score,
      duration, region, summary, content_md, link, published_at, updated_at, expires_at,
      expired, first_seen, last_seen, source_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
      COALESCE((SELECT source_name FROM activities WHERE id = ?), ?))
    ON CONFLICT(id) DO UPDATE SET
      vendor = excluded.vendor,
      title = excluded.title,
      category = excluded.category,
      type = excluded.type,
      tier = excluded.tier,
      score = excluded.score,
      duration = excluded.duration,
      region = excluded.region,
      summary = excluded.summary,
      content_md = excluded.content_md,
      link = excluded.link,
      published_at = COALESCE(excluded.published_at, activities.published_at),
      updated_at = COALESCE(excluded.updated_at, activities.updated_at),
      expires_at = COALESCE(excluded.expires_at, activities.expires_at),
      expired = excluded.expired,
      last_seen = excluded.last_seen
  `);
  stmt.run(
    a.id, a.source, a.sourceId, a.vendor, a.title, a.category || null, a.type, a.tier, a.score || 0,
    a.duration || null, a.region || null, a.summary || null, a.contentMd || null, a.link || null,
    a.publishedAt || null, a.updatedAt || null, a.expiresAt || null,
    a.expired ? 1 : 0, a.firstSeen || now, now,
    a.id, a.sourceName || null
  );
}

function markStaleExpired() {
  // expires_at 已过 → 标记过期（datetime() 归一化解析 ISO/时区偏移）
  db.exec(`UPDATE activities SET expired = 1
           WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now') AND expired = 0`);
}

function queryActivities(f = {}) {
  const where = [];
  const params = [];
  if (!f.includeExpired) where.push('expired = 0');
  if (f.type) { where.push('type = ?'); params.push(f.type); }
  if (f.tier) { where.push('tier = ?'); params.push(f.tier); }
  if (f.vendor) { where.push('vendor = ?'); params.push(f.vendor); }
  if (f.q) {
    where.push('(title LIKE ? OR summary LIKE ? OR content_md LIKE ? OR vendor LIKE ?)');
    const like = `%${f.q}%`;
    params.push(like, like, like, like);
  }
  if (f.windowDays > 0) {
    where.push(`datetime(COALESCE(MAX(published_at, updated_at, first_seen), first_seen)) >= datetime('now', ?)`);
    params.push(`-${f.windowDays} days`);
  }
  const order = f.sort === 'score' ? 'score DESC, first_seen DESC' : 'first_seen DESC, score DESC';
  const sql = `SELECT * FROM activities ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${order} LIMIT 500`;
  return db.prepare(sql).all(...params);
}

function listVendors() {
  return db.prepare(`
    SELECT vendor, COUNT(*) AS total, SUM(CASE WHEN expired = 0 THEN 1 ELSE 0 END) AS active
    FROM activities GROUP BY vendor ORDER BY active DESC, total DESC`).all();
}

function stats() {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN expired = 0 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN expired = 1 THEN 1 ELSE 0 END) AS expired,
      COUNT(DISTINCT vendor) AS vendors,
      SUM(CASE WHEN first_seen >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS new7d,
      SUM(CASE WHEN type = 'signup' AND expired = 0 THEN 1 ELSE 0 END) AS signup,
      SUM(CASE WHEN type = 'daily'  AND expired = 0 THEN 1 ELSE 0 END) AS daily
    FROM activities`).get() || {};
  const crawl = db.prepare(`SELECT value FROM meta WHERE key = 'last_crawl'`).get();
  return {
    active: row.active || 0,
    expired: row.expired || 0,
    vendors: row.vendors || 0,
    new7d: row.new7d || 0,
    signup: row.signup || 0,
    daily: row.daily || 0,
    lastCrawl: crawl ? crawl.value : null,
    crawling: !!global.__freehubCrawling,
  };
}

function getMeta(key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  db.prepare(`INSERT INTO meta(key, value) VALUES(?,?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

module.exports = { open, upsertActivity, queryActivities, listVendors, stats, getMeta, setMeta, markStaleExpired, _db: () => db };
