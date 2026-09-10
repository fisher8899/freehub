/**
 * 编排器: 组装上下文、按预算调度探针、聚合判定、落盘报告。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { OpenAiClient } from './http.js'
import { Evidence, STATUS } from './evidence.js'
import { probeInfra } from './probes/infra.js'
import { probeTokenizer } from './probes/tokenizer.js'
import { probeIdentity } from './probes/identity.js'
import { probeOneToken } from './probes/onetoken.js'
import { probeCapability } from './probes/capability.js'
import { probeLongContext } from './probes/longcontext.js'
import { probeStability } from './probes/stability.js'
import { renderMarkdown } from './report/md.js'
import { renderHtml } from './report/html.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODELS = JSON.parse(readFileSync(join(HERE, 'references/models.json'), 'utf-8'))

export const TOOL_VERSION = '0.1.0'

export function resolveClaimedMeta(model) {
  const m = String(model).toLowerCase()
  for (const [key, meta] of Object.entries(MODELS.models)) {
    const aliases = (meta.aliases ?? []).map((a) => a.toLowerCase())
    if (aliases.includes(m)) return { key, ...meta }
    // 前缀/包含匹配(如 "gpt-4o-2024-11-20" / "openai/gpt-4o-mini-2024-07-18")
    if (aliases.some((a) => m === a || m.includes(a) || a.includes(m))) return { key, fuzzy: true, ...meta }
  }
  return null
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} [opts.budget=standard]  quick | standard | deep
 * @param {string} [opts.refPath]          自采行为指纹参考
 * @param {string} [opts.outDir]           输出目录
 * @param {boolean} [opts.noExec]          不在本地执行模型生成的代码
 * @param {string[]} [opts.suites]         要运行的探针(id 列表),缺省全部
 * @param {(line:string)=>void} [opts.log]
 */
export async function runAudit(opts) {
  const log = opts.log ?? (() => {})
  const budget = opts.budget ?? 'standard'
  const client = new OpenAiClient({
    baseUrl: opts.baseUrl, apiKey: opts.apiKey, model: opts.model,
    timeoutMs: opts.timeoutMs ?? 60_000,
    concurrency: opts.concurrency ?? 4,
  })
  const evidence = new Evidence()
  const claimedMeta = resolveClaimedMeta(opts.model)
  const ctx = {
    client, evidence, log, budget,
    claimedMeta, refPath: opts.refPath, noExec: opts.noExec,
    paramSupport: null, signal: opts.signal,
  }

  evidence.add('run.config', {
    tool: `water-audit v${TOOL_VERSION}`,
    baseUrl: client.baseUrl, model: client.model,
    budget, refPath: opts.refPath ?? null,
    claimedModelKnown: !!claimedMeta,
    claimedKey: claimedMeta?.key ?? null,
    startedAt: new Date().toISOString(),
  })

  const suites = opts.suites ?? ['infra', 'tokenizer', 'identity', 'onetoken', 'capability', 'longcontext', 'stability']
  const probeMap = {
    infra: ['基础设施指纹', probeInfra],
    tokenizer: ['分词器指纹', probeTokenizer],
    identity: ['身份与知识截止', probeIdentity],
    onetoken: ['单 token 行为指纹', probeOneToken],
    capability: ['能力分层评测', probeCapability],
    longcontext: ['长上下文一致性', probeLongContext],
    stability: ['稳定性与缓存', probeStability],
  }

  const results = []
  for (const id of suites) {
    if (opts.signal?.aborted) break // 取消: 在探针边界生效
    const [title, fn] = probeMap[id]
    if (!fn) continue
    log(`▶ ${title}`)
    try {
      const r = await fn(ctx)
      results.push(r)
      if (r.id === 'infra') ctx.paramSupport = r.metrics.paramSupport
    } catch (e) {
      results.push({
        id, title, status: STATUS.INCONCLUSIVE, confidence: '低',
        summary: `探针执行失败: ${e?.message ?? e}`, metrics: {}, findings: [{ level: 'warn', text: String(e?.stack ?? e).slice(0, 400) }], evidenceIds: [], raw: null,
      })
    }
    log(`  → ${statusLabel(r0(results).status)}`)
  }

  const agg = aggregate(results, claimedMeta)
  const report = {
    meta: {
      tool: `water-audit v${TOOL_VERSION}`,
      generatedAt: new Date().toISOString(),
      baseUrl: client.baseUrl,
      model: client.model,
      budget,
      claimedModelKnown: !!claimedMeta,
      claimedKey: claimedMeta?.key ?? null,
      node: process.version,
      usage: client.stats,
    },
    verdict: agg,
    results,
  }

  // 落盘
  const outDir = opts.outDir ?? join(process.cwd(), 'reports', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${sanitize(opts.model)}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(report), 'utf-8')
  writeFileSync(join(outDir, 'report.html'), renderHtml(report), 'utf-8')
  writeFileSync(join(outDir, 'evidence.jsonl'), evidence.toJSONL(), 'utf-8')
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(report, null, 1), 'utf-8')
  log(`\n✓ 报告已生成: ${outDir}`)
  return { report, outDir }
}

function r0(arr) { return arr[arr.length - 1] ?? { status: 'na' } }

/**
 * 聚合判定 —— 规则完全透明:
 *  - mismatch 硬证据(行为指纹不符 / 分词器不符且声称模型分词器已知 / 多层能力远低于公开带)
 *    ≥1 → 「证据表明不符」
 *  - 否则 suspicious 信号存在 → 「发现可疑信号」
 *  - 否则多数维度 consistent → 「未发现注水证据」
 *  - 有效证据不足(半数以上维度 inconclusive/na)→ 「证据不足,无法判定」
 * 注意: 「未发现注水证据」≠ 证明没注水。
 */
export function aggregate(results, claimedMeta) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]))
  const mismatchDims = results.filter((r) => r.status === STATUS.MISMATCH).map((r) => r.title)
  const suspiciousDims = results.filter((r) => r.status === STATUS.SUSPICIOUS).map((r) => r.title)
  const consistentDims = results.filter((r) => r.status === STATUS.CONSISTENT).map((r) => r.title)
  const incertainDims = results.filter((r) => r.status === STATUS.INCONCLUSIVE || r.status === STATUS.NA).map((r) => r.title)

  // 硬证据权重评估
  const hardEvidence = []
  if (byId.onetoken?.status === STATUS.MISMATCH) hardEvidence.push(`行为指纹与参考不符(meanJSD=${byId.onetoken.metrics?.meanJsd?.toFixed?.(3)})`)
  const tokenizerKnownFamily = claimedMeta?.tokenizer != null
  if (byId.tokenizer?.status === STATUS.MISMATCH) {
    hardEvidence.push(tokenizerKnownFamily
      ? `分词器计数与声称模型的已知分词器(${claimedMeta.tokenizer})不符`
      : '分词器计数与所有已收录分词器不符(声称模型的分词器未收录,证据力减弱)')
  }
  if (byId.capability?.status === STATUS.MISMATCH) hardEvidence.push('能力分层显著低于声称模型的公开分数带')
  if (byId.stability?.status === STATUS.MISMATCH) hardEvidence.push('确定性算术全部答错')

  let status, headline
  const effective = results.filter((r) => r.status !== STATUS.NA)
  if (effective.length && effective.filter((r) => r.status === STATUS.INCONCLUSIVE).length > effective.length / 2) {
    status = STATUS.INCONCLUSIVE
    headline = '证据不足,无法判定(多数探针未取得有效数据)'
  } else if (hardEvidence.length >= 1) {
    status = STATUS.MISMATCH
    headline = `证据表明与声称模型不符(硬证据 ${hardEvidence.length} 项)`
  } else if (suspiciousDims.length >= 1) {
    status = STATUS.SUSPICIOUS
    headline = `未发现实锤,但存在 ${suspiciousDims.length} 项可疑信号,建议提高预算复测或用官方 key 做同协议比对`
  } else if (consistentDims.length >= 1) {
    status = STATUS.CONSISTENT
    headline = '未发现注水证据(注意:这不等同于证明没注水;行为/分词器/能力三层均未检出与声称模型的矛盾)'
  } else {
    status = STATUS.INCONCLUSIVE
    headline = '证据不足,无法判定'
  }

  return { status, headline, hardEvidence, mismatchDims, suspiciousDims, consistentDims, inconclusiveDims: incertainDims }
}

export function statusLabel(s) {
  return {
    consistent: '一致', suspicious: '可疑', mismatch: '不符',
    inconclusive: '无法判定', na: '不适用',
  }[s] ?? s
}

function sanitize(s) { return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) }
