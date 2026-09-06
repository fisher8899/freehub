'use strict';
/**
 * 活动分类引擎：
 *  - type  注册送 signup / 每日打卡送 daily / 登录即领 login / 长期免费 free / 限时体验 limited
 *  - tier  gold(≥80) / silver(≥60) / copper(其余)，对应 freeegg 的 tier=gold,silver,copper
 *  打分制：标题命中 ×3、摘要 ×2、正文 ×1，取最高分；平分按 fixedOrder 兜底。
 */

const RULES = [
  { type: 'daily', label: '每日打卡送', icon: '📅',
    patterns: [/每日(签到|登录|领|送|打卡)/, /(每天|每日)/, /签到/, /打卡/, /连续登录/, /\bdaily\b/i, /check[- ]?in/i,
      /每\s*\d+\s*(小时|天)(自动)?刷新/, /周期(自动)?刷新/] },
  { type: 'signup', label: '注册送', icon: '🎁',
    patterns: [/注册/, /新用户/, /新人礼?/, /新人(专|福利|免费|最高|领)/, /首次(登录|注册|使用|充值)?/, /signup/i, /开服礼?/, /邀(请|友)注册/,
      /开通(即|后)(自动)?(发放|到账|送|领)/, /自动发放|自动到账/] },
  { type: 'limited', label: '限时体验', icon: '⏳',
    patterns: [/限时/, /限期/, /限量/, /\b(beta|公测|内测)\b/i, /公测/, /内测/, /测试体验/, /体验(卡|服|营|活动|期)?/, /试用/, /活动(期间)?/, /周末/, /开学/, /周年(庆)?/, /红包/, /大放送/, /学生(认证|优惠)?/, /先到先得/] },
  { type: 'free', label: '长期免费', icon: '🆓',
    patterns: [/永久免费/, /免费档/, /免费模型/, /免费调用/, /免费畅(聊|用)/, /免费使用/, /免费额度/, /免费 ?api/i, /free (model|tier|api|pool)/i, /免费池/, /长期免费/, /每月免费/, /免费领.*(每月|每日)/] },
  { type: 'login', label: '登录即领', icon: '👉',
    patterns: [/登录(后)?(即|就|可)?(领|送|得)/, /(免费)?领(取|券|额度|福利)/, /白嫖/, /一键?领取/, /(点击|前往)领取/, /(直接)?送\s*[\d一二三四五六七八九十几亿]/, /赠送/] },
];

// 平分时的优先顺序（daily/signup 信息量最大，优先标注）
const FIXED_ORDER = ['daily', 'signup', 'limited', 'free', 'login'];

function classifyType(title = '', summary = '', content = '') {
  const t = title || '';
  const s = summary || '';
  const c = content || '';
  const scores = {};
  for (const rule of RULES) {
    let sc = 0;
    for (const p of rule.patterns) {
      if (p.test(t)) sc += 3;
      if (p.test(s)) sc += 2;
      if (p.test(c)) sc += 1;
    }
    if (sc > 0) scores[rule.type] = sc;
  }
  const keys = Object.keys(scores);
  if (!keys.length) return { type: 'limited', typeLabel: RULES.find(r => r.type === 'limited').label, icon: '⏳', matched: false };
  keys.sort((a, b) => scores[b] - scores[a] || FIXED_ORDER.indexOf(a) - FIXED_ORDER.indexOf(b));
  const rule = RULES.find(r => r.type === keys[0]);
  return { type: rule.type, typeLabel: rule.label, icon: rule.icon, matched: true };
}

function classifyTier(score = 0) {
  if (score >= 80) return 'gold';
  if (score >= 60) return 'silver';
  return 'copper';
}

function normalizeDate(v) {
  if (!v) return null;
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch { return null; }
}

module.exports = { classifyType, classifyTier, normalizeDate };
