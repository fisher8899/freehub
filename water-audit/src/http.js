/**
 * 极简 OpenAI 兼容客户端(Node ≥18.17 内置 fetch,零依赖)。
 *
 * 记录一切可用于审计的旁证:状态码、响应头(筛过的关键字段)、id 形态、
 * usage、TTFT / 生成速度、SSE chunk 结构等。所有原始证据进入 evidence 记录。
 */

export class ApiError extends Error {
  /**
   * @param {string} kind  auth | transport | http4xx | http5xx | parse | timeout
   */
  constructor(kind, message, { status = 0, body = null, headers = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.body = body
    this.headers = headers
  }
}

const HEADER_WHITELIST = [
  'server', 'content-type', 'x-request-id', 'cf-ray', 'via', 'x-powered-by',
  'openai-version', 'openai-processing-ms', 'openai-organization', 'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests', 'x-ratelimit-reset-tokens', 'anthropic-ratelimit-requests-limit',
  'date', 'alt-svc', 'x-oneapi-request-id', 'x-new-api-version', 'x-oneapi-version',
]

function pickHeaders(h) {
  const out = {}
  h?.forEach?.((v, k) => {
    const kk = k.toLowerCase()
    if (HEADER_WHITELIST.includes(kk) || kk.startsWith('x-') || kk.startsWith('openai') || kk.startsWith('anthropic')) {
      out[kk] = String(v).slice(0, 200)
    }
  })
  return out
}

export class OpenAiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   例: https://api.example.com/v1 (自动去掉尾部斜杠)
   * @param {string} opts.apiKey
   * @param {string} opts.model
   * @param {number} [opts.timeoutMs=60000]
   * @param {number} [opts.maxRetries=2]
   * @param {number} [opts.concurrency=4]
   */
  constructor({ baseUrl, apiKey, model, timeoutMs = 60_000, maxRetries = 2, concurrency = 4 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.concurrency = concurrency
    this.totalRequests = 0
    this.totalPromptTokens = 0
    this.totalCompletionTokens = 0
    this.totalErrors = 0
  }

  get stats() {
    return {
      requests: this.totalRequests,
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      errors: this.totalErrors,
    }
  }

  url(path) { return `${this.baseUrl}${path}` }

  headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...extra,
    }
  }

  /**
   * 非流式 chat completion。返回统一结构并附审计旁证。
   * @param {object} body  除 model 外的请求体(可含 messages/temperature/max_tokens/...)
   */
  async chat(body, { retries = undefined, signal = undefined } = {}) {
    const maxRetries = retries ?? this.maxRetries
    let lastErr = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(new ApiError('timeout', 'request timeout')), this.timeoutMs)
      const onOuter = () => ctrl.abort()
      signal?.addEventListener('abort', onOuter, { once: true })
      const t0 = Date.now()
      this.totalRequests++
      try {
        const res = await fetch(this.url('/chat/completions'), {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ model: this.model, ...body }),
          signal: ctrl.signal,
        })
        const latencyMs = Date.now() - t0
        const resHeaders = pickHeaders(res.headers)
        const text = await res.text()
        if (res.status === 401 || res.status === 403) {
          throw new ApiError('auth', `认证失败 HTTP ${res.status}`, { status: res.status, body: text.slice(0, 500), headers: resHeaders })
        }
        if (!res.ok) {
          const kind = res.status < 500 ? 'http4xx' : 'http5xx'
          lastErr = new ApiError(kind, `HTTP ${res.status}`, { status: res.status, body: text.slice(0, 2000), headers: resHeaders })
          // 4xx 一般是参数问题,重试无意义;5xx 重试
          if (kind === 'http4xx') throw lastErr
        } else {
          let json
          try { json = JSON.parse(text) } catch {
            throw new ApiError('parse', '响应不是合法 JSON', { body: text.slice(0, 500), headers: resHeaders })
          }
          const choice = json?.choices?.[0]
          const content = choice?.message?.content
          if (content == null && !json?.error) {
            throw new ApiError('parse', '响应缺少 choices[0].message.content', { body: text.slice(0, 500), headers: resHeaders })
          }
          if (json?.usage) {
            this.totalPromptTokens += json.usage.prompt_tokens ?? 0
            this.totalCompletionTokens += json.usage.completion_tokens ?? 0
          }
          return {
            ok: true,
            json,
            content: typeof content === 'string' ? content : JSON.stringify(content),
            reasoningContent: choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? null,
            finishReason: choice?.finish_reason ?? null,
            usage: json.usage ?? null,
            modelEcho: json.model ?? null,
            id: json.id ?? null,
            object: json.object ?? null,
            systemFingerprint: json.system_fingerprint ?? null,
            serviceTier: json.service_tier ?? null,
            created: json.created ?? null,
            latencyMs,
            headers: resHeaders,
            attempt,
          }
        }
      } catch (e) {
        if (e instanceof ApiError) {
          // 认证 / 4xx 参数错 / 解析失败:重试无意义,立即抛出
          if (e.kind === 'auth' || e.kind === 'http4xx' || e.kind === 'parse') throw e
          lastErr = e
        } else if (e?.name === 'AbortError') {
          lastErr = new ApiError('timeout', `超时(${this.timeoutMs}ms)`)
        } else {
          lastErr = new ApiError('transport', String(e?.cause?.code || e?.message || e))
        }
        this.totalErrors++
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onOuter)
      }
    }
    throw lastErr ?? new ApiError('transport', '未知错误')
  }

  /**
   * 流式 chat completion(SSE)。逐 chunk 记录结构;返回拼接文本与结构审计。
   */
  async chatStream(body, { signal = undefined } = {}) {
    const t0 = Date.now()
    this.totalRequests++
    let ttftMs = null
    const chunks = []
    let content = ''
    let usage = null
    let modelEcho = null
    let id = null
    let firstChunkShape = null
    let sawDone = false
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(this.timeoutMs * 2, 120_000))
    signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
    try {
      const res = await fetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.model, ...body, stream: true }),
        signal: ctrl.signal,
      })
      const resHeaders = pickHeaders(res.headers)
      if (!res.ok) {
        const text = await res.text()
        throw new ApiError(res.status === 401 || res.status === 403 ? 'auth' : res.status < 500 ? 'http4xx' : 'http5xx',
          `流式请求 HTTP ${res.status}`, { status: res.status, body: text.slice(0, 1000), headers: resHeaders })
      }
      const contentType = res.headers.get('content-type') || ''
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let genChars = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''
        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (trimmed.startsWith(':')) continue // 注释行
          if (trimmed === 'data: [DONE]') { sawDone = true; continue }
          if (!trimmed.startsWith('data:')) {
            chunks.push({ kind: 'non-sse-line', value: trimmed.slice(0, 120) })
            continue
          }
          try {
            const payload = JSON.parse(trimmed.slice(5).trim())
            if (!id) id = payload.id ?? null
            if (!modelEcho) modelEcho = payload.model ?? null
            const delta = payload?.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length) {
              if (ttftMs === null) ttftMs = Date.now() - t0
              content += delta
              genChars += delta.length
            }
            if (payload.usage) usage = payload.usage
            if (!firstChunkShape) {
              firstChunkShape = {
                keys: Object.keys(payload),
                choiceKeys: payload.choices?.[0] ? Object.keys(payload.choices[0]) : null,
                hasDeltaRole: 'role' in (payload?.choices?.[0]?.delta ?? {}),
              }
            }
          } catch {
            chunks.push({ kind: 'bad-json', value: trimmed.slice(0, 120) })
          }
        }
      }
      const wallMs = Date.now() - t0
      if (usage) {
        this.totalPromptTokens += usage.prompt_tokens ?? 0
        this.totalCompletionTokens += usage.completion_tokens ?? 0
      } else if (content) {
        this.totalCompletionTokens += Math.round(content.length / 4)
      }
      return {
        ok: true, content, chunks: chunks.slice(0, 20), sawDone, firstChunkShape,
        usage, modelEcho, id, ttftMs, wallMs,
        contentType,
        charsPerSec: genChars / Math.max(0.001, (wallMs - (ttftMs ?? 0)) / 1000),
        headers: resHeaders,
      }
    } catch (e) {
      this.totalErrors++
      if (e instanceof ApiError) throw e
      throw new ApiError('transport', String(e?.message || e))
    } finally {
      clearTimeout(timer)
    }
  }

  /** GET /models */
  async listModels() {
    const t0 = Date.now()
    this.totalRequests++
    try {
      const res = await fetch(this.url('/models'), { headers: this.headers() })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 保留原文 */ }
      return {
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - t0,
        headers: pickHeaders(res.headers),
        json,
        textSnippet: text.slice(0, 2000),
        listsClaimedModel: !!json?.data?.some?.((m) => String(m.id).toLowerCase() === String(this.model).toLowerCase()),
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e), latencyMs: Date.now() - t0 }
    }
  }

  /** 简单并发池 */
  async pool(jobs, concurrency = this.concurrency) {
    const results = new Array(jobs.length)
    let next = 0
    async function worker() {
      while (true) {
        const i = next++
        if (i >= jobs.length) return
        results[i] = await jobs[i]()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
    return results
  }
}
