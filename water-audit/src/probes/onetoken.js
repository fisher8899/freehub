/**
 * 单 token 行为指纹探针(编排 oneToken 引擎)。
 *
 * 两种参考来源:
 *  1. 内置论文参考(bruckner-zenodo-2026, 11 个模型, 指示性比对);
 *  2. --ref 自采参考(enroll 产出, 同协议严格比对, 结论最硬)。
 * 另外对全部内置参考做最近邻识别(端点行为最像哪个已知模型),
 * 作为「BEST_MATCH」线索输出(诚实标注: 指示性,非判定)。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runOneTokenBattery, fingerprintFromSamples, compareWithReference, splitHalfCheck } from '../oneToken.js'
import { cellsForPreset, samplesPerCellFor } from '../battery.js'
import { STATUS, result } from '../evidence.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REFS = JSON.parse(readFileSync(join(HERE, '../references/behavioral-fingerprints.json'), 'utf-8'))

export async function probeOneToken(ctx) {
  const { client, evidence, log, budget, claimedMeta, refPath } = ctx
  const evIds = []
  const preset = budget === 'deep' ? 'strict' : budget === 'quick' ? 'quick' : 'standard'
  const cellIds = cellsForPreset(preset)
  const spc = samplesPerCellFor(preset)

  log(`  [one-token] 预设 ${preset}: ${cellIds.length} 格 × ${spc} 采样 = ${cellIds.length * spc} 次请求`)
  const run = await runOneTokenBattery(client, { cellIds, samplesPerCell: spc, log, signal: ctx.signal })
  evIds.push(evidence.add('onetoken.fingerprint', {
    adapter: run.adapter.strategy, postReasoning: run.adapter.postReasoning,
    preset, samplesPerCell: spc,
    cells: Object.fromEntries(Object.entries(run.fingerprint).map(([k, v]) => [k, { counts: v.counts, valid: v.valid, invalid: v.invalid, refusal: v.refusal, empty: v.empty }])),
    sampleAnswers: run.samples.slice(0, 40).map((s) => ({ cellId: s.cellId, q: s.paraphrase?.slice(0, 40), a: String(s.raw ?? '').slice(0, 30), category: s.category })),
  }))

  const half = splitHalfCheck(run.samples, cellIds)
  evIds.push(evidence.add('onetoken.splithalf', half))
  const findings = []

  // 参考选择: 自采优先,其次内置中声称模型的参考
  let refInfo = null
  let strictProtocol = false
  if (refPath) {
    try {
      refInfo = JSON.parse(readFileSync(refPath, 'utf-8'))
      strictProtocol = true
      findings.push({ level: 'info', text: `使用自采参考(${refPath}, 协议 ${refInfo.protocol ?? 'one-token/v1'}, 采集于 ${refInfo.collectedAt ?? '未知日期'})` })
    } catch {
      findings.push({ level: 'warn', text: `自采参考文件读取失败: ${refPath},回退到内置参考` })
    }
  }
  let claimedRefKey = null
  if (!refInfo && claimedMeta?.behavioralRefId && REFS.models[claimedMeta.behavioralRefId]) {
    claimedRefKey = claimedMeta.behavioralRefId
  }

  let comparison = null
  const refSource = refInfo ?? (claimedRefKey ? REFS : null)
  if (refSource) {
    const refCells = refInfo ? refInfo.cells : REFS.models[claimedRefKey].cells
    comparison = compareWithReference(run.fingerprint, refCells)
    evIds.push(evidence.add('onetoken.comparison', { ref: refInfo ? refPath : claimedRefKey, ...comparison, thresholds: { match: 0.25, mismatch: 0.35 } }))
    const top = comparison.perCell.slice(0, 4).map((c) => `${c.cellId} JSD=${c.jsd.toFixed(3)}`).join(', ')
    findings.push({
      level: comparison.verdict === 'match' ? 'info' : comparison.verdict === 'mismatch' ? 'mismatch' : 'suspicious',
      text: comparison.verdict === 'insufficient'
        ? '可比格子不足,无法判定(提高预算或换用 strict 预设)'
        : `与${refInfo ? '自采' : '内置论文'}参考的平均 JSD=${comparison.meanJsd.toFixed(3)} → ${verdictLabel(comparison.verdict)}(阈值: ≤0.25 match / >0.35 mismatch;最大离格: ${top})`,
    })
  } else {
    findings.push({ level: 'warn', text: `内置参考库中没有声称模型 ${client.model} 的行为指纹(可用官方 key 运行 enroll 自采参考)` })
  }

  // 最近邻识别(指示性)
  const neighbors = []
  for (const [key, model] of Object.entries(REFS.models)) {
    const c = compareWithReference(run.fingerprint, model.cells)
    if (c.meanJsd !== null) neighbors.push({ model: key, meanJsd: +c.meanJsd.toFixed(3), comparable: c.comparableCells })
  }
  neighbors.sort((a, b) => a.meanJsd - b.meanJsd)
  evIds.push(evidence.add('onetoken.neighbors', { neighbors }))

  let status = STATUS.INCONCLUSIVE
  if (comparison) {
    if (comparison.verdict === 'match') status = STATUS.CONSISTENT
    else if (comparison.verdict === 'uncertain') status = STATUS.SUSPICIOUS
    else if (comparison.verdict === 'mismatch') status = STATUS.MISMATCH
  }
  if (half.suspicious) findings.push({ level: 'suspicious', text: `split-half 自检: ${half.note}(meanJSD=${half.meanJsd?.toFixed(3)})` })
  if (run.errorCount > 0) findings.push({ level: 'note', text: `${run.errorCount}/${cellIds.length * spc} 次探针请求失败(已从分布中剔除)` })
  if (run.adapter.postReasoning) findings.push({ level: 'note', text: '该端点未能关闭推理通道,指纹基于推理后文本,置信度降低' })

  const nn = neighbors[0]
  const summaryParts = []
  if (comparison) summaryParts.push(`与${refInfo ? '自采' : '内置'}参考比对: ${verdictLabel(comparison.verdict)}(meanJSD=${comparison.meanJsd?.toFixed(3)}, ${comparison.comparableCells} 格可比)`)
  else summaryParts.push('无同声称模型参考,仅做最近邻识别')
  if (nn) summaryParts.push(`行为最近邻: ${nn.model}(meanJSD=${nn.meanJsd}, 指示性)`)

  return result({
    id: 'onetoken', title: '单 token 行为指纹', status,
    confidence: strictProtocol ? '高' : '中',
    score: comparison?.meanJsd != null ? Math.round(Math.max(0, Math.min(1, 1 - comparison.meanJsd / 0.463)) * 100) : null,
    scoreFormula: '行为一致度 = max(0, 1 − meanJSD/0.463) ×100(0.463 为论文「不同模型」中位基线;线性映射仅为展示,判定以阈值带为准)',
    summary: summaryParts.join(';'),
    metrics: { meanJsd: comparison?.meanJsd ?? null, verdict: comparison?.verdict ?? 'no-ref', comparableCells: comparison?.comparableCells ?? 0, neighbors: neighbors.slice(0, 5), splitHalf: { meanJsd: half.meanJsd, suspicious: half.suspicious }, adapter: run.adapter.strategy },
    findings, evidenceIds: evIds,
    raw: { perCell: comparison?.perCell ?? [], neighbors, fingerprint: run.fingerprint },
  })
}

function verdictLabel(v) {
  return { match: '一致(match)', uncertain: '存疑(uncertain)', mismatch: '不符(mismatch)', insufficient: '证据不足(insufficient)' }[v] ?? v
}

/** enroll 子命令: 在(官方)端点采集指纹,供后续同协议严格比对 */
export async function enrollReference(ctx, outPath) {
  const { client, evidence, log, budget } = ctx
  const preset = budget === 'deep' ? 'strict' : 'standard'
  const cellIds = cellsForPreset(preset)
  const spc = samplesPerCellFor(preset)
  log(`[enroll] 采集参考指纹: ${cellIds.length} 格 × ${spc} = ${cellIds.length * spc} 次请求`)
  const run = await runOneTokenBattery(client, { cellIds, samplesPerCell: spc, log, signal: ctx.signal })
  const fp = fingerprintFromSamples(run.samples.filter((s) => s.category !== 'error'))
  const doc = {
    formatVersion: 1,
    protocol: 'one-token/v1',
    model: client.model,
    baseUrl: client.baseUrl,
    collectedAt: new Date().toISOString(),
    preset,
    samplesPerCell: spc,
    adapter: run.adapter.strategy,
    cells: Object.fromEntries(Object.entries(fp).map(([k, v]) => [k, { counts: v.counts, valid: v.valid, invalid: v.invalid, refusal: v.refusal, empty: v.empty, error: v.error }])),
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, JSON.stringify(doc, null, 1), 'utf-8')
  evidence.add('enroll.saved', { outPath, cells: Object.keys(fp).length })
  return doc
}
