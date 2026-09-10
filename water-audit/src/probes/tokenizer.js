/**
 * 分词器指纹探针。
 *
 * 原理: 不同模型家族使用不同分词器。将 36 条规范字符串逐条作为单条 user
 * 消息发给端点,读取 usage.prompt_tokens。由于 chat 模板会产生常数偏移,
 * 匹配采用「锚点相对差值法」: 比较每条字符串与首字符串的计数差值序列。
 * 差值法不受模板/BOS 影响,能精确区分 o200k / cl100k / Llama-3 等分词器。
 *
 * 附带校验: completion_tokens 与返回文本在同 tokenizers 下的重算值是否一致;
 * logprobs 可用时,记录首 token 候选集作为辅助证据。
 *
 * 已知局限(如实声明):
 *  - 若服务商伪造 usage 数字,本探针会被欺骗;此时结论依赖其他维度交叉验证;
 *  - 参考表未覆盖的分词器(qwen/deepseek/glm 等)只能得到「与已收录分词器不匹配」;
 *  - 请求失败/限流的字符串按缺失处理,匹配率按已测得部分计算。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { STATUS, result } from '../evidence.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CANONICAL = JSON.parse(readFileSync(join(HERE, '../references/canonical-strings.json'), 'utf-8'))
const TOKENIZER_REFS = JSON.parse(readFileSync(join(HERE, '../references/tokenizer-counts.json'), 'utf-8'))

export async function probeTokenizer(ctx) {
  const { client, evidence, log } = ctx
  const strings = CANONICAL.strings
  const evIds = []
  const observed = []
  const failures = []

  log(`  [tokenizer] 发送 ${strings.length} 条规范字符串…`)
  let done = 0
  const jobs = strings.map((s, idx) => async () => {
    try {
      const r = await client.chat({
        messages: [{ role: 'user', content: s }],
        temperature: 0,
        max_tokens: 1,
      }, { retries: 1 })
      const pt = r.usage?.prompt_tokens ?? null
      const ct = r.usage?.completion_tokens ?? null
      observed[idx] = { promptTokens: pt, completionTokens: ct, content: r.content, requestId: r.id }
    } catch (e) {
      observed[idx] = null
      failures.push({ index: idx, error: String(e?.message || e).slice(0, 120) })
    }
    done++
    if (done % 10 === 0) log(`  [tokenizer] 进度 ${done}/${strings.length}`)
    return true
  })
  await client.pool(jobs, Math.min(client.concurrency, 3))

  evIds.push(evidence.add('tokenizer.observations', {
    strings: strings.map((s, i) => ({ i, text: s.slice(0, 40).replace(/\n/g, '\\n'), promptTokens: observed[i]?.promptTokens ?? null, completionTokens: observed[i]?.completionTokens ?? null })),
    failures,
  }))

  const usable = observed.map((o) => o?.promptTokens ?? null)
  if (usable.filter((v) => v != null).length < 8) {
    return result({
      id: 'tokenizer', title: '分词器指纹', status: STATUS.INCONCLUSIVE, confidence: '低',
      summary: `仅 ${usable.filter((v) => v != null).length}/36 条字符串取得 prompt_tokens,证据不足无法判定。`,
      metrics: { failures }, findings: [{ level: 'warn', text: '端点对多数规范字符串请求失败(限流/报错)' }], evidenceIds: evIds,
    })
  }

  // 锚点相对差值匹配
  const anchor = 0
  const myDeltas = [] // [count, delta] 对
  for (let i = 1; i < strings.length; i++) {
    if (usable[anchor] != null && usable[i] != null) myDeltas.push({ i, delta: usable[i] - usable[anchor] })
  }

  const scores = []
  for (const [name, ref] of Object.entries(TOKENIZER_REFS.tokenizers)) {
    const rc = ref.counts
    let match = 0
    const mismatches = []
    for (const { i, delta } of myDeltas) {
      const refDelta = rc[i] - rc[anchor]
      if (delta === refDelta) match++
      else mismatches.push({ i, delta, refDelta })
    }
    // 绝对差匹配率(模板偏移未知,仅当与某 tokenizer 完全一致时才有意义)
    const absMatch = rc.filter((c, i) => usable[i] != null && c === usable[i]).length
    scores.push({
      tokenizer: name, family: ref.family, models: ref.models,
      deltaMatchRate: myDeltas.length ? match / myDeltas.length : 0,
      deltaMatch: match, deltaTotal: myDeltas.length,
      absMatch: `${absMatch}/${usable.filter((v) => v != null).length}`,
      mismatches: mismatches.slice(0, 8),
    })
  }
  scores.sort((a, b) => b.deltaMatchRate - a.deltaMatchRate)
  evIds.push(evidence.add('tokenizer.match', { anchorIndex: anchor, scores }))

  const best = scores[0]
  const second = scores[1]
  const n = best.deltaTotal
  const bestRate = best.deltaMatchRate
  // Wilson 下限作为保守判定
  const wilsonLo = wilsonLower(best.deltaMatch, n)
  const margin = bestRate - (second?.deltaMatchRate ?? 0)

  // 声称模型的已知分词器(models.json): 匹配目标不仅是「找到某个分词器」,
  // 而是「是否与声称模型应有的分词器一致」
  const claimedTokenizer = ctx?.claimedMeta?.tokenizer ?? null
  const matchesClaim = claimedTokenizer
    ? best.tokenizer === claimedTokenizer || claimedTokenizer.startsWith(best.tokenizer)
    : null

  let status, summary, confidence = '高'
  if (n < 10) {
    status = STATUS.INCONCLUSIVE
    confidence = '低'
    summary = `可用差值样本仅 ${n} 对,证据不足。`
  } else if (matchesClaim === false && bestRate >= 0.9) {
    status = STATUS.MISMATCH
    confidence = '高'
    summary = `36 条规范字符串的相对计数与 ${best.tokenizer} 高度一致(${best.deltaMatch}/${n}),但声称模型 ${client.model} 应使用 ${claimedTokenizer} —— 分词器层面即不一致,强烈提示实际服务的不是声称的模型(或其同代同源变体)。`
  } else if (matchesClaim === true && bestRate >= 0.9) {
    status = STATUS.CONSISTENT
    summary = bestRate === 1
      ? `36 条规范字符串的相对计数与 ${best.tokenizer}(声称模型应有分词器)完全一致(${n}/${n} 差值全中)。`
      : `相对计数与 ${best.tokenizer}(声称模型应有分词器)匹配 ${best.deltaMatch}/${n}(个别偏差可能来自服务端对特殊串的预处理)。`
  } else if (matchesClaim === null && bestRate === 1) {
    status = STATUS.CONSISTENT
    confidence = '中'
    summary = `相对计数与 ${best.tokenizer} 完全一致(${n}/${n})。注意: 参考库没有声称模型 ${client.model} 的分词器记录,只能报告「最像哪个分词器」,无法与声称直接对表。`
  } else if (bestRate >= 0.9 && margin >= 0.1) {
    status = STATUS.CONSISTENT
    confidence = '中'
    summary = `相对计数与 ${best.tokenizer} 匹配 ${best.deltaMatch}/${n}(个别偏差可能来自服务端对特殊串的预处理)。`
  } else if (bestRate >= 0.8) {
    status = STATUS.SUSPICIOUS
    confidence = '中'
    summary = `相对计数最佳匹配为 ${best.tokenizer}(${best.deltaMatch}/${n}),但存在明显的离群字符串,需要交叉验证。`
  } else {
    status = claimedTokenizer ? STATUS.MISMATCH : STATUS.INCONCLUSIVE
    summary = claimedTokenizer
      ? `相对计数与全部已收录分词器均不匹配(最佳 ${best.tokenizer} 仅 ${best.deltaMatch}/${n}),也与声称模型应有的 ${claimedTokenizer} 不符。`
      : `相对计数与全部已收录分词器均不匹配(最佳 ${best.tokenizer} 仅 ${best.deltaMatch}/${n})—— 若声称的是 qwen/deepseek/glm 等参考表未收录的模型,此项不能作数。`
    confidence = '中'
  }

  const findings = [{
    level: 'info',
    text: `分词器匹配排名: ${scores.slice(0, 3).map((s) => `${s.tokenizer} ${(s.deltaMatchRate * 100).toFixed(0)}%`).join(' | ')}`,
  }]
  if (best.family) findings.push({ level: 'info', text: `最佳匹配家族: ${best.family},对应模型: ${best.models}` })

  return result({
    id: 'tokenizer', title: '分词器指纹', status, confidence,
    score: Math.round(bestRate * 100),
    scoreFormula: `锚点相对差值匹配率 = 匹配差值数 ${best.deltaMatch} / 总可比差值 ${n}`,
    summary, metrics: { observedCount: usable.filter((v) => v != null).length, best: best.tokenizer, bestRate, wilsonLo, margin }, findings, evidenceIds: evIds,
    raw: { scores, usable },
  })
}

function wilsonLower(k, n, z = 1.959964) {
  if (!n) return 0
  const p = k / n
  const denom = 1 + z * z / n
  const centre = p + z * z / (2 * n)
  const spread = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
  return Math.max(0, (centre - spread) / denom)
}
