/**
 * 稳定性与真实性探针: 确定性、缓存、logprobs 劣化信号。
 *
 *  - 确定性: temperature=0 同一算术题 ×5 —— 输出是否一致(全对且一致
 *    说明是真的在跑模型;答案错了则连算术都错,本身就是严重信号)。
 *  - 缓存检测: 同一「要求随机码」的刁钻提示 ×3(temperature=1)——
 *    字节级完全一致的概率≈0,一致 → 疑似网关缓存/录像重放。
 *  - logprobs 劣化信号: 若支持 logprobs,记录固定提示下生成 token 的
 *    平均 logprob 与困惑度代理值(绝对值无参考意义,作为档案与后续
 *    「同端点复测对比」的基线)。
 */
import { STATUS, result } from '../evidence.js'
import { stdev } from '../stats.js'

export async function probeStability(ctx) {
  const { client, evidence, log, paramSupport } = ctx
  const evIds = []
  const findings = []
  const metrics = {}

  // 1) 确定性(温度 0)
  log('  [stability] 确定性 ×5')
  const detPrompt = '计算 12345×6789 等于多少?只输出数字。'
  const detRuns = []
  await client.pool(Array.from({ length: 5 }, () => async () => {
    try {
      const r = await client.chat({ messages: [{ role: 'user', content: detPrompt }], temperature: 0, max_tokens: 30, seed: 42 }, { retries: 1 })
      detRuns.push(r.content.trim())
    } catch { detRuns.push('(失败)') }
    return true
  }), 3)
  const detDistinct = new Set(detRuns).size
  metrics.determinism = { runs: detRuns, distinct: detDistinct }
  evIds.push(evidence.add('stability.determinism', { runs: detRuns }))
  const detCorrect = detRuns.filter((r) => r.replace(/[,，\s]/g, '').includes('83810205')).length
  if (detCorrect === 5 && detDistinct === 1) findings.push({ level: 'info', text: '温度 0 下 5 次全对且输出一致:确定性正常' })
  else if (detCorrect === 0) findings.push({ level: 'mismatch', text: `5 次算术(12345×6789=83810205)全部答错: ${detRuns.join(' | ').slice(0, 120)} —— 连确定性算术都错,与任何主流声称模型严重不符` })
  else findings.push({ level: detDistinct === 1 ? 'info' : 'note', text: `5 次输出 ${detDistinct} 种(答对 ${detCorrect}/5)` })

  // 2) 缓存检测(温度 1,要求随机)
  log('  [stability] 缓存/重放检测 ×3')
  const cachePrompt = '请随机生成一个 8 位数字码,只输出这个码,不要其他内容。'
  const cacheRuns = []
  await client.pool(Array.from({ length: 3 }, () => async () => {
    try {
      const r = await client.chat({ messages: [{ role: 'user', content: cachePrompt }], temperature: 1, max_tokens: 20 }, { retries: 1 })
      cacheRuns.push(r.content.trim())
    } catch { cacheRuns.push('(失败)') }
    return true
  }), 1)
  const okRuns = cacheRuns.filter((r) => r !== '(失败)')
  const cacheIdentical = okRuns.length === 3 && new Set(okRuns).size === 1
  metrics.cacheProbe = { runs: cacheRuns, identical: cacheIdentical }
  evIds.push(evidence.add('stability.cache', { runs: cacheRuns }))
  if (cacheIdentical) findings.push({ level: 'suspicious', text: '温度 1 下 3 次「随机码」输出完全相同:疑似网关缓存或录像重放(单次复现概率≈0;若服务商默认 seed=0 也可能造成,需复核)' })
  else findings.push({ level: 'info', text: '温度 1 随机码 3 次互不相同,未见缓存重放迹象' })

  // 3) logprobs 劣化信号(如支持)
  const logprobsSupported = paramSupport?.['logprobs']?.accepted
  if (logprobsSupported) {
    log('  [stability] logprobs 劣化信号采样 ×2')
    const lps = []
    for (const prompt of [
      '请解释「守株待兔」的含义,50 字以内。',
      'What is the capital of Australia? Answer in one sentence.',
    ]) {
      try {
        const r = await client.chat({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0, max_tokens: 80, logprobs: true, top_logprobs: 3,
        }, { retries: 1 })
        const lp = r.json?.choices?.[0]?.logprobs?.content ?? []
        const tokens = lp.map((t) => t.logprob)
        const avgLp = tokens.length ? tokens.reduce((s, v) => s + v, 0) / tokens.length : null
        // 困惑度代理: exp(-avg logprob)
        const perplexityProxy = avgLp !== null ? Math.exp(-avgLp) : null
        lps.push({ prompt: prompt.slice(0, 30), tokenCount: tokens.length, avgLogprob: avgLp !== null ? +avgLp.toFixed(3) : null, perplexityProxy: perplexityProxy !== null ? +perplexityProxy.toFixed(2) : null })
      } catch { lps.push({ prompt: prompt.slice(0, 30), error: true }) }
    }
    metrics.logprobs = lps
    evIds.push(evidence.add('stability.logprobs', { samples: lps }))
    const good = lps.filter((l) => l.perplexityProxy != null)
    if (good.length) findings.push({ level: 'info', text: `logprobs 可用,已记录平均 logprob/困惑度代理值(作为本端点基线,供复测对比;无官方参考值,不单独判分)` })
  } else {
    findings.push({ level: 'note', text: '端点不支持 logprobs(或被网关剥离),量化劣化的概率级检测不可用' })
  }

  let status = STATUS.CONSISTENT
  if (detCorrect === 0) status = STATUS.MISMATCH
  else if (cacheIdentical) status = STATUS.SUSPICIOUS

  const summary = findings.map((f) => f.text).join(';')
  return result({
    id: 'stability', title: '稳定性与缓存', status, confidence: '中',
    summary, metrics, findings, evidenceIds: evIds, raw: { detRuns, cacheRuns },
  })
}
