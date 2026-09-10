/**
 * 基础设施指纹探针:不问模型,只审「管道」。
 * 检测: /models 列表、响应字段形态、错误体格式、SSE 结构、参数支持矩阵、
 *       延迟画像(TTFT/生成速度)、推理框架特征。用于识别服务商接栈方式
 *       (官方 / Azure / vLLM / one-api 系中转 等),为中转识别提供证据。
 */
import { ApiError } from '../http.js'
import { STATUS, result } from '../evidence.js'

export async function probeInfra(ctx) {
  const { client, evidence, log } = ctx
  const findings = []
  const evIds = []
  const metrics = {}
  const stackSignals = {}

  // 1) /v1/models
  log('  [infra] GET /models')
  const models = await client.listModels()
  evIds.push(evidence.add('infra.models', { request: `GET ${client.url('/models')}`, ...pick(models, ['ok', 'status', 'latencyMs', 'headers', 'listsClaimedModel', 'textSnippet', 'error']) }))
  metrics.modelsListed = models.ok ? (models.json?.data?.length ?? null) : null
  metrics.claimedInModels = models.ok ? models.listsClaimedModel : null
  if (models.ok && !models.listsClaimedModel) findings.push({ level: 'note', text: `/models 列表中未出现声称的模型 ${client.model}(部分网关不透传该接口,单独不构成证据)` })

  // 2) 基础非流式请求 + 字段形态
  log('  [infra] 基础 chat 请求与响应字段形态')
  let base = null
  try {
    base = await client.chat({ messages: [{ role: 'user', content: 'Say "pong".' }], temperature: 0, max_tokens: 10 }, { retries: 1 })
    evIds.push(evidence.add('infra.chat-basic', pick(base, ['id', 'object', 'modelEcho', 'systemFingerprint', 'serviceTier', 'created', 'usage', 'finishReason', 'headers', 'latencyMs', 'content'])))
    metrics.idFormat = classifyId(base.id)
    metrics.hasSystemFingerprint = base.systemFingerprint != null
    metrics.systemFingerprint = base.systemFingerprint
    metrics.hasServiceTier = base.serviceTier != null
    metrics.usageFields = base.usage ? Object.keys(base.usage) : []
    metrics.objectField = base.object
    metrics.modelEcho = base.modelEcho
    if (base.modelEcho != null && String(base.modelEcho) !== String(client.model)) {
      findings.push({ level: 'note', text: `响应 model 字段为 "${base.modelEcho}",与请求的 "${client.model}" 不同 —— 常见于网关改写或上游换名` })
    }
    if (base.object === 'chat.completion' && metrics.idFormat === 'chatcmpl-legacy') stackSignals.openaiLike = (stackSignals.openaiLike ?? 0) + 2
    if (base.systemFingerprint != null) stackSignals.openaiLike = (stackSignals.openaiLike ?? 0) + 1
  } catch (e) {
    evIds.push(evidence.add('infra.chat-basic-error', { error: String(e?.message || e), kind: e?.kind }))
    findings.push({ level: 'warn', text: `基础请求失败: ${e?.message}` })
  }

  // 3) 错误体格式(请求不存在的模型名 —— 无害探测)
  log('  [infra] 错误体格式探测')
  try {
    const bad = new OpenAiProbeOnly(client)
    const r = await bad.chatRaw({ model: 'water-audit-nonexistent-model-8f3d', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
    evIds.push(evidence.add('infra.error-shape', { status: r.status, bodySnippet: String(r.body).slice(0, 400), headers: r.headers }))
    metrics.errorShape = classifyErrorBody(r.status, r.body)
    if (metrics.errorShape === 'oneapi-style') stackSignals.oneapi = (stackSignals.oneapi ?? 0) + 2
    if (metrics.errorShape === 'openai-style') stackSignals.openaiLike = (stackSignals.openaiLike ?? 0) + 1
  } catch (e) {
    evIds.push(evidence.add('infra.error-shape-error', { error: String(e?.message || e), kind: e?.kind, bodySnippet: String(e?.body ?? '').slice(0, 400) }))
    if (e?.body != null) {
      metrics.errorShape = classifyErrorBody(e.status ?? 0, e.body)
      if (metrics.errorShape === 'oneapi-style') stackSignals.oneapi = (stackSignals.oneapi ?? 0) + 2
    }
  }

  // 4) 流式结构 + 速度画像
  log('  [infra] SSE 流式结构与速度画像')
  try {
    const stream = await client.chatStream({ messages: [{ role: 'user', content: '从 1 数到 30,用顿号分隔,不要其他文字。' }], temperature: 0.7, max_tokens: 200 })
    evIds.push(evidence.add('infra.stream', pick(stream, ['sawDone', 'firstChunkShape', 'contentType', 'ttftMs', 'wallMs', 'charsPerSec', 'usage', 'modelEcho', 'id', 'chunks', 'headers'])))
    metrics.streamDoneSentinel = stream.sawDone
    metrics.firstChunkShape = stream.firstChunkShape
    metrics.ttftMs = stream.ttftMs
    metrics.charsPerSec = Math.round(stream.charsPerSec)
    if (stream.sawDone) stackSignals.openaiLike = (stackSignals.openaiLike ?? 0) + 1
    if (stream.contentType?.includes('text/event-stream')) stackSignals.openaiLike = (stackSignals.openaiLike ?? 0) + 1
  } catch (e) {
    evIds.push(evidence.add('infra.stream-error', { error: String(e?.message || e), kind: e?.kind }))
    findings.push({ level: 'warn', text: `流式请求失败: ${e?.message}` })
  }

  // 5) 参数支持矩阵
  log('  [infra] 参数支持矩阵')
  metrics.paramSupport = await paramMatrix(client, evidence, evIds)

  // 6) 栈判定
  const stack = inferStack(stackSignals, metrics)
  metrics.stackGuess = stack.guess
  metrics.stackSignals = stackSignals
  findings.push({ level: 'info', text: `接栈特征判定: ${stack.guess}(基于响应/错误/SSE 形态的启发式,仅供参考)` })

  let status = STATUS.CONSISTENT
  let summary = `基础设施审计完成: 栈特征=${stack.guess}`
  if (findings.some((f) => f.level === 'warn')) { status = STATUS.INCONCLUSIVE; summary += ';部分探测失败' }
  return result({
    id: 'infra', title: '基础设施指纹', status, confidence: '中',
    summary, metrics, findings, evidenceIds: evIds,
  })
}

async function paramMatrix(client, evidence, evIds) {
  const base = { messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }
  const cases = [
    { name: 'logprobs', body: { ...base, logprobs: true, top_logprobs: 3 } },
    { name: 'seed', body: { ...base, seed: 42 } },
    { name: 'n=2', body: { ...base, n: 2 } },
    { name: 'temperature=2.5(官方拒绝>2)', body: { ...base, temperature: 2.5 } },
    { name: 'max_completion_tokens', body: { messages: base.messages, max_completion_tokens: 5 } },
    { name: 'response_format=json_object', body: { messages: [{ role: 'user', content: '输出 JSON {"ok":true}' }], max_tokens: 20, response_format: { type: 'json_object' } } },
    { name: 'presence_penalty=2.0(官方拒绝>1.5)', body: { ...base, presence_penalty: 2.0 } },
    { name: 'unknown_param(官方严格校验会拒绝)', body: { ...base, water_audit_probe_param: 1 } },
  ]
  const out = {}
  for (const c of cases) {
    try {
      const r = await client.chat(c.body, { retries: 0 })
      out[c.name] = { accepted: true, note: r.json?.choices?.[0]?.logprobs ? '返回了 logprobs' : undefined }
      evIds.push(evidence.add('infra.param', { param: c.name, accepted: true, status: 200 }))
    } catch (e) {
      const rejected = e?.kind === 'http4xx'
      out[c.name] = { accepted: false, rejected, status: e?.status ?? null, error: String(e?.message || e).slice(0, 120) }
      evIds.push(evidence.add('infra.param', { param: c.name, accepted: false, rejected, status: e?.status ?? null, bodySnippet: String(e?.body ?? '').slice(0, 300) }))
    }
  }
  return out
}

function classifyId(id) {
  if (id == null) return null
  const s = String(id)
  if (/^chatcmpl-[A-Za-z0-9]{20,}$/.test(s)) return 'chatcmpl-legacy'
  if (/^chatcmpl-/i.test(s)) return 'chatcmpl-other'
  if (/^chatcmpt-/.test(s)) return 'chatcmpt(oneapi 系常见)'
  return s.slice(0, 24)
}

function classifyErrorBody(status, body) {
  let j = null
  try { j = JSON.parse(body) } catch { return 'non-json' }
  const s = JSON.stringify(j)
  if (typeof j?.error === 'object' && typeof j.error.message === 'string' && 'type' in (j.error ?? {})) return 'openai-style'
  if (typeof j?.error === 'object' && typeof j.error.message === 'string') return 'openai-style-loose'
  if (j?.error?.message != null && j?.error?.code != null) return 'openai-style-loose'
  if (/one-?api|new-?api/i.test(s)) return 'oneapi-style'
  if (j?.message != null && j?.success === false) return 'oneapi-style'
  if (j?.message != null && j?.code != null && j?.data === null) return 'oneapi-style'
  return 'other'
}

function inferStack(signals, metrics) {
  let best = '无法判定'
  const score = { officialOpenai: signals.openaiLike ?? 0, oneapiRelay: signals.oneapi ?? 0 }
  if (metrics.errorShape === 'openai-style') score.officialOpenai += 1
  if (metrics.hasSystemFingerprint) score.officialOpenai += 1
  if (/chatcmpl-[A-Za-z0-9]{20,}/.test(String(metrics.idFormat))) score.officialOpenai += 1
  if (score.officialOpenai >= 3 && score.oneapiRelay === 0) best = 'OpenAI 官方风格(直连或高保真透传)'
  else if (score.officialOpenai >= 2 && score.oneapiRelay >= 1) best = 'OpenAI 风格 + 疑似中转网关(混合特征)'
  else if (score.oneapiRelay >= 1) best = 'one-api / new-api 系中转网关'
  else if (score.officialOpenai >= 1) best = 'OpenAI 兼容实现(vLLM/SGLang/自建网关等)'
  return { guess: best }
}

function pick(obj, keys) {
  const o = {}
  for (const k of keys) if (obj && obj[k] !== undefined) o[k] = obj[k]
  return o
}

/** 仅用于错误体探测的裸请求器(不影响统计) */
class OpenAiProbeOnly {
  constructor(client) { this.client = client }
  async chatRaw(body) {
    const res = await fetch(this.client.url('/chat/completions'), {
      method: 'POST',
      headers: this.client.headers(),
      body: JSON.stringify(body),
    })
    const bodyText = await res.text()
    return { status: res.status, body: bodyText, headers: res.headers }
  }
}
