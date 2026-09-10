/**
 * 长上下文一致性探针(检测「注水」最常见的形态之一: 号称 128K 实际 8K)。
 *
 * 方法: 合成大量无关但结构合理的填充文本(虚构人物事实,种子随机,不可预测),
 * 在指定深度插入一句带唯一暗号的句子,末尾提问暗号。
 *  - 答对 + 服务端报告的 prompt_tokens 与发送文本匹配 → 该长度可用;
 *  - 答错 + prompt_tokens 远小于文本估算 token 数 → 疑似服务端截断;
 *  - prompt_tokens 若为 0/缺失/明显造假(与文本长度完全无关)→ 记录为异常证据。
 *
 * 填充文本由种子随机生成,模型无法靠先验猜中暗号,判分完全确定。
 */
import { STATUS, result } from '../evidence.js'

const FIRST = ['林晚舟', '赵砚秋', '沈墨白', '苏念安', '周慕云', '顾清和', '陆听澜', '江疏影', '温子墨', '秦若飞', '白敬亭', '程锦年']
const CITY = ['临江市', '云溪县', '望舒镇', '青崖村', '南麓县', '沧浪市', '梧桐里', '雁归城']
const ROLE = ['中学语文教师', '桥梁工程师', '中药铺掌柜', '民俗博物馆馆长', '天气预报员', '茶艺师', '古籍修复师', '灯塔管理员']

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildCorpus(targetChars, seed) {
  const rand = mulberry32(seed)
  const needleCode = `ZW-${Math.floor(rand() * 90000 + 10000)}`
  const paras = []
  const fillerFact = (i) => {
    const p1 = FIRST[Math.floor(rand() * FIRST.length)]
    const c1 = CITY[Math.floor(rand() * CITY.length)]
    const r1 = ROLE[Math.floor(rand() * ROLE.length)]
    const y = 1950 + Math.floor(rand() * 70)
    const n2 = Math.floor(rand() * 90 + 10)
    return `人物志第${i}条:${p1}生于${y}年,长期在${c1}担任${r1}。据地方志记载,他一生整理过${n2}册档案,晚年在${CITY[Math.floor(rand() * CITY.length)]}度过。`
  }
  let total = 0
  let i = 1
  while (total < targetChars) {
    const p = fillerFact(i)
    paras.push(p)
    total += p.length + 1
    i++
  }
  const text = paras.join('\n')
  const needle = `\n特别记录:机要暗号为「${needleCode}」,此暗号仅此一处出现。\n`
  const pos = Math.floor(text.length * 0.5)
  const full = text.slice(0, pos) + needle + text.slice(pos)
  return { full, needleCode, paraCount: i, chars: full.length }
}

export async function probeLongContext(ctx) {
  const { client, evidence, log, claimedMeta, budget } = ctx
  const claimed = claimedMeta?.contextTokens ?? null
  // 预算 → 探测长度(字符)。中英混合文本 1 token ≈ 2.5-3.5 字符,取保守 2.8。
  const sizesByBudget = {
    quick: [16_000],
    standard: [16_000, 64_000],
    deep: [16_000, 64_000, 160_000, 400_000],
  }
  let sizes = sizesByBudget[budget] ?? sizesByBudget.standard
  if (claimed) {
    const claimedChars = claimed * 2.8
    sizes = sizes.filter((s) => s <= claimedChars * 1.05)
    if (!sizes.length) sizes = [Math.min(16_000, Math.floor(claimedChars))]
  }
  const evIds = []
  const results = []
  const findings = []

  for (const size of sizes) {
    const seed = 20260910 + size
    const { full, needleCode, chars } = buildCorpus(size, seed)
    const prompt = `${full}\n\n以上是一部虚构人物志。请回答:文中出现的「机要暗号」是什么?只回答暗号本身。`
    const estTokens = Math.round(chars / 2.8)
    log(`  [longctx] 探测 ${chars} 字符(≈${estTokens} tokens)…`)
    try {
      const r = await client.chat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 30,
      }, { retries: 0 })
      const served = r.usage?.prompt_tokens ?? null
      const hit = r.content.includes(needleCode)
      const servedRatio = served != null ? served / estTokens : null
      results.push({ sizeChars: chars, estTokens, servedPromptTokens: served, servedRatio: servedRatio != null ? +servedRatio.toFixed(2) : null, hit, answer: r.content.trim().slice(0, 60), needleCode })
      evIds.push(evidence.add('longcontext.run', { sizeChars: chars, estTokens, servedPromptTokens: served, hit, answer: r.content.trim().slice(0, 120), usage: r.usage }))
      if (!hit && servedRatio != null && servedRatio < 0.75) {
        findings.push({ level: 'suspicious', text: `约 ${estTokens} tokens 的请求,服务端报告仅处理 ${served} tokens(比例 ${(servedRatio * 100).toFixed(0)}%),且未答中暗号 —— 疑似服务端截断了上下文` })
      }
      if (served != null && (served === 0 || servedRatio !== null && servedRatio > 2.0)) {
        findings.push({ level: 'note', text: `prompt_tokens 报告值异常(${served},估算 ${estTokens}),usage 数字可能不可信` })
      }
    } catch (e) {
      results.push({ sizeChars: chars, estTokens, servedPromptTokens: null, hit: null, answer: `(请求失败: ${String(e?.message || e).slice(0, 80)})` })
      evIds.push(evidence.add('longcontext.error', { sizeChars: chars, error: String(e?.message || e).slice(0, 200) }))
    }
  }

  const graded = results.filter((r) => r.hit !== null)
  const hits = graded.filter((r) => r.hit).length
  const truncationSuspect = findings.some((f) => f.level === 'suspicious')
  let status = STATUS.INCONCLUSIVE
  if (graded.length >= 1 && truncationSuspect) status = STATUS.SUSPICIOUS
  else if (graded.length >= 1 && hits === graded.length) status = STATUS.CONSISTENT
  else if (graded.length >= 2 && hits === 0) status = STATUS.SUSPICIOUS

  const summary = graded.length
    ? `暗号检索 ${hits}/${graded.length} 通过;实测有效长度: ${graded.filter((r) => r.hit).map((r) => `${(r.estTokens / 1000).toFixed(0)}k`).join('/') || '无'} tokens${claimed ? `(声称 ${Math.round(claimed / 1000)}k)` : ''}`
    : '长上下文请求全部失败,无法判定'

  return result({
    id: 'longcontext', title: '长上下文一致性', status, confidence: '中',
    summary, metrics: { claimedContextTokens: claimed, results }, findings, evidenceIds: evIds, raw: { results },
  })
}
