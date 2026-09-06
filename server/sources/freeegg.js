'use strict';
/**
 * freeegg.top 采集源 —— 该站为纯静态，数据即 https://freeegg.top/data/eggs.json
 * 字段：{id,title,vendor,category,score,tags:{duration,region},expired,expiryDate,
 *       summary,content(markdown),images,link,publishedAt,updatedAt}
 */

const FREEEGG_DATA = 'https://freeegg.top/data/eggs.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) freehub/1.0';

async function fetchFreeegg() {
  const res = await fetch(FREEEGG_DATA, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`freeegg HTTP ${res.status}`);
  const data = await res.json();
  const eggs = Array.isArray(data) ? data : (data.eggs || []);
  return eggs.map(e => ({
    sourceId: String(e.id || e.title),
    vendor: e.vendor || '未知厂商',
    title: e.title || '(无标题)',
    category: e.category || null,
    score: Number(e.score) || 0,
    duration: e.tags?.duration || null,
    region: e.tags?.region || null,
    summary: e.summary || '',
    contentMd: e.content || '',
    link: e.link || 'https://freeegg.top/',
    publishedAt: e.publishedAt || null,
    updatedAt: e.updatedAt || null,
    expiresAt: e.expiryDate || null,
    expired: !!e.expired,
    images: Array.isArray(e.images) ? e.images : [],
  }));
}

module.exports = { fetchFreeegg };
