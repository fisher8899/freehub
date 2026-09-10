/**
 * 单 token 行为指纹:采集、聚合、对比。
 *
 * 方法(arXiv:2607.10252):
 *  - 每格(cell)= 任务×语言,固定最小系统提示词,max_tokens=16,temperature=1.0;
 *  - 每格多次采样得到回答分布,归一化后比较;
 *  - 两枚指纹的距离 = 两侧均 ≥10 个有效样本的格子上的平均 JSD(base-2);
 *  - 判定阈值: ≤0.25 match / 0.25-0.35 uncertain / >0.35 mismatch
 *    (依据: 同模型跨服务商中位 0.227,不同模型中位 0.463);
 *  - split-half 自检: 将本次样本对半分自比,若自身距离偏高 → 端点多后端轮换/不稳定。
 */

import { normalizeAnswer } from './normalizer.js'
import { getDomain, getSystemPrompt, pickParaphrase, PROBE_MAX_TOKENS, PROBE_TEMPERATURE, POST_REASONING_MAX_TOKENS } from './battery.js'
import { jsdBits, mean, JSD_THRESHOLDS, JSD_BASELINES, MIN_VALID_PER_CELL, MIN_COMPARABLE_CELLS, SPLIT_HALF_WARN } from './stats.js'

export function fingerprintFromSamples(samples) {
  const byCell = {}
  for (const s of samples) {
    const c = (byCell[s.cellId] ??= { counts: {}, valid: 0, invalid: 0, refusal: 0, empty: 0, error: 0, raw: [] })
    c[s.category] = (c[s.category] ?? 0) + 1
    if (s.category === 'valid') c.counts[s.normalized] = (c.counts[s.normalized] ?? 0) + 1
    if (c.raw.length < 200) c.raw.push({ q: s.paraphrase, a: String(s.raw ?? '').slice(0, 60), category: s.category })
  }
  return byCell
}

/** 与参考分布比较:返回每格 JSD 与均值判定。 */
export function compareWithReference(fpByCell, refCells) {
  const perCell = []
  for (const [cellId, ref] of Object.entries(refCells)) {
    const mine = fpByCell[cellId]
    if (!mine) continue
    const refCounts = ref.counts ?? ref
    const myValid = mine.valid ?? Object.values(mine.counts ?? {}).reduce((s, n) => s + n, 0)
    const refValid = Object.values(refCounts).reduce((s, n) => s + n, 0)
    if (myValid < MIN_VALID_PER_CELL || refValid < MIN_VALID_PER_CELL) continue
    const jsd = jsdBits(mine.counts, refCounts)
    if (jsd === null) continue
    perCell.push({ cellId, jsd, validSelf: myValid, validRef: refValid })
  }
  perCell.sort((a, b) => b.jsd - a.jsd)
  const meanJsd = perCell.length ? mean(perCell.map((c) => c.jsd)) : null
  let verdict
  if (meanJsd === null || perCell.length < MIN_COMPARABLE_CELLS) verdict = 'insufficient'
  else if (meanJsd <= JSD_THRESHOLDS.match) verdict = 'match'
  else if (meanJsd <= JSD_THRESHOLDS.mismatch) verdict = 'uncertain'
  else verdict = 'mismatch'
  return { perCell, meanJsd, verdict, comparableCells: perCell.length }
}

/** split-half 自检:同一次采集对半分,自比距离。高 → 端点自身不稳定(疑似多后端轮换)。 */
export function splitHalfCheck(samples, cellIds) {
  const perCell = []
  for (const cellId of cellIds) {
    const valid = samples.filter((s) => s.cellId === cellId && s.category === 'valid')
    if (valid.length < 10) continue
    const half = Math.floor(valid.length / 2)
    const a = {}, b = {}
    for (let i = 0; i < half; i++) a[valid[i].normalized] = (a[valid[i].normalized] ?? 0) + 1
    for (let i = half; i < valid.length; i++) b[valid[i].normalized] = (b[valid[i].normalized] ?? 0) + 1
    const jsd = jsdBits(a, b)
    if (jsd !== null) perCell.push({ cellId, jsd, n: valid.length })
  }
  const meanJsd = perCell.length ? mean(perCell.map((c) => c.jsd)) : null
  return {
    perCell,
    meanJsd,
    suspicious: meanJsd !== null && meanJsd > SPLIT_HALF_WARN,
    note: meanJsd === null ? '有效样本不足' : meanJsd > SPLIT_HALF_WARN ? '前后两半自比距离偏高:端点输出分布不稳定,疑似多后端轮换或缓存' : '自身稳定',
  }
}

/**
 * 在端点上运行完整探针库。reasoning 关闭策略自动探测。
 * @param {import('./http.js').OpenAiClient} client
 */
export async function runOneTokenBattery(client, { cellIds, samplesPerCell, log = () => {}, signal } = {}) {
  const adapter = await detectReasoningAdapter(client, { log, signal })
  const jobs = []
  for (const cellId of cellIds) {
    for (let i = 0; i < samplesPerCell; i++) {
      jobs.push({ cellId, paraphrase: pickParaphrase(cellId) })
    }
  }
  // 洗牌:避免同一格连发,降低端点缓存/限流造成的系统性偏差
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[jobs[i], jobs[j]] = [jobs[j], jobs[i]]
  }
  let done = 0
  const samples = await client.pool(jobs.map((job) => async () => {
    let sample
    try {
      const r = await client.chat({
        messages: [
          { role: 'system', content: getSystemPrompt(job.cellId) },
          { role: 'user', content: job.paraphrase },
        ],
        temperature: PROBE_TEMPERATURE,
        max_tokens: adapter.postReasoning ? POST_REASONING_MAX_TOKENS : PROBE_MAX_TOKENS,
        ...(adapter.extraBody ?? {}),
      }, { retries: 1, signal })
      const { normalized, category } = normalizeAnswer(r.content, getDomain(job.cellId))
      sample = { ...job, raw: r.content, normalized, category, requestId: r.id }
    } catch (e) {
      sample = { ...job, raw: null, normalized: null, category: 'error', error: String(e?.message || e) }
    }
    done++
    if (done % 20 === 0 || done === jobs.length) log(`  one-token 探针进度 ${done}/${jobs.length}`)
    return sample
  }), client.concurrency)

  const okSamples = samples.filter((s) => s.category !== 'error')
  const fp = fingerprintFromSamples(okSamples)
  return {
    adapter,
    samples,
    fingerprint: fp,
    errorCount: samples.length - okSamples.length,
  }
}

async function detectReasoningAdapter(client, { log = () => {}, signal } = {}) {
  const { adapterHintOrder, REASONING_STRATEGY_BODIES, getSystemPrompt, pickParaphrase } = await import('./battery.js')
  const cellId = 'random-number-1-100:en'
  for (const strategy of adapterHintOrder(client.baseUrl)) {
    try {
      const r = await client.chat({
        messages: [
          { role: 'system', content: getSystemPrompt(cellId) },
          { role: 'user', content: pickParaphrase(cellId) },
        ],
        temperature: PROBE_TEMPERATURE,
        max_tokens: PROBE_MAX_TOKENS,
        ...REASONING_STRATEGY_BODIES[strategy],
      }, { retries: 0, signal })
      if (r.content.trim().length > 0) {
        log(`  推理关闭策略: ${strategy}`)
        return { strategy, extraBody: REASONING_STRATEGY_BODIES[strategy], postReasoning: false }
      }
    } catch (e) {
      if (e instanceof Error && e.kind === 'auth') throw e
      continue
    }
  }
  try {
    const r = await client.chat({
      messages: [
        { role: 'system', content: getSystemPrompt(cellId) },
        { role: 'user', content: pickParaphrase(cellId) },
      ],
      temperature: PROBE_TEMPERATURE,
      max_tokens: PROBE_MAX_TOKENS,
    }, { retries: 0, signal })
    if (r.content.trim().length > 0) {
      log('  推理关闭策略: none(裸请求)')
      return { strategy: 'none', extraBody: {}, postReasoning: false }
    }
  } catch { /* fallthrough */ }
  log('  ⚠ 无法关闭推理通道,降级为 post-reasoning(max_tokens=1024),指纹置信度降低')
  return { strategy: 'post-reasoning', extraBody: {}, postReasoning: true }
}
