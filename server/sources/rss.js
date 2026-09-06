'use strict';
/**
 * 通用 RSS / Atom 采集源（零依赖，正则解析）。
 * 用途：微信公众号转 RSS（如 wechat2rss.xlab.app / feeddd 等桥接服务）、
 *      厂商官方博客 RSS、GitHub Releases Atom 等。
 * 条目按关键词过滤（免费/送/领取/体验/签到/注册/token/积分/额度/公测/内测/福利…）。
 */

const KEYWORDS = /(免费|白嫖|羊毛|福利|领取|免费领|送\s*[\d一二三四五六七八九]|赠送|额度|积分|token|体验|试用|公测|内测|测试|签到|打卡|注册|新用户|新人|模型|api|限时|放送)/i;

function decodeEntities(s = '') {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
const stripCdata = s => {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
};
const stripHtml = s => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(stripCdata(m[1])) : '';
}

function pickLink(block) {
  // RSS: <link>https://…</link>；Atom: <link href="https://…" …/>
  const atom = block.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  const rss = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rss && stripCdata(rss[1]).startsWith('http')) return stripCdata(rss[1]);
  if (atom) return decodeEntities(atom[1]);
  if (rss) return stripCdata(rss[1]);
  return '';
}

function parseFeed(xml) {
  const items = [];
  const rssBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const atomBlocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of [...rssBlocks, ...atomBlocks]) {
    const title = stripHtml(pick(b, 'title'));
    const link = pickLink(b);
    const dateStr = pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date');
    let description = pick(b, 'description') || pick(b, 'summary') || pick(b, 'content:encoded') || pick(b, 'content');
    description = stripHtml(description).slice(0, 500);
    if (!title) continue;
    items.push({ title, link, dateStr, description });
  }
  return items;
}

/**
 * @param {string} url feed 地址
 * @param {string} fallbackVendor feed 名称（作为厂商兜底）
 */
async function fetchRss(url, fallbackVendor) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) freehub/1.0', Accept: '*/*' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`rss HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseFeed(xml).filter(it => KEYWORDS.test(it.title) || KEYWORDS.test(it.description));
  return items.map(it => {
    // 厂商识别：feed 名优先；否则尝试标题中「XX：/XX:」前缀
    let vendor = fallbackVendor;
    const m = it.title.match(/^([\u4e00-\u9fa5A-Za-z0-9·\.\- ]{1,16})[：:]\s*(.+)$/);
    if (!fallbackVendor && m) vendor = m[1].trim();
    return {
      sourceId: it.link || it.title,
      vendor: vendor || 'RSS 订阅',
      title: it.title,
      category: null,
      score: 55,
      duration: null,
      region: null,
      summary: it.description,
      contentMd: it.description ? `${it.description}\n\n> 来自 RSS：${it.title}` : '',
      link: it.link || url,
      publishedAt: it.dateStr || null,
      updatedAt: null,
      expiresAt: null,
      expired: false,
      images: [],
    };
  });
}

module.exports = { fetchRss, parseFeed, KEYWORDS };
