'use strict';
/**
 * GitHub 免费 LLM 资源清单采集源。
 * 拉取 raw README，按行解析「| 厂商 | 说明 | 链接 |」表格 / 列表行，
 * 只保留与中文福利关键词相关的条目（该清单多为英文资源，默认关闭）。
 */

const KEYWORDS = /(free|trial|credit|额度|免费|试用|注册送|新人|token)/i;

async function fetchGithubList(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'freehub/1.0' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`github HTTP ${res.status}`);
  const md = await res.text();
  const items = [];
  const seen = new Set();
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!/^\|?\s*[-*]?\s*\[/.test(line) && !/^\|\s*\[/.test(line)) continue; // markdown 链接行/表格行
    const linkM = line.match(/\[([^\]]+)\]\((https?:[^)\s]+)\)/);
    if (!linkM) continue;
    const name = linkM[1].trim();
    const link = linkM[2];
    const rest = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '').replace(/^\||\|$/g, '').replace(/\|/g, ' ').trim();
    const text = `${name} ${rest}`;
    if (!KEYWORDS.test(text)) continue;
    const key = link;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      sourceId: key,
      vendor: name.replace(/\s*\(.*?\)\s*/g, '').slice(0, 40) || 'GitHub 清单',
      title: name,
      category: null,
      score: 50,
      duration: null,
      region: null,
      summary: rest.slice(0, 300) || 'GitHub 免费 LLM 资源清单条目',
      contentMd: rest ? `${rest}\n\n> 来自 GitHub 清单` : '',
      link,
      publishedAt: null,
      updatedAt: null,
      expiresAt: null,
      expired: false,
      images: [],
    });
  }
  return items;
}

module.exports = { fetchGithubList };
