/**
 * 审计任务管理器: 队列调度、后台执行、日志捕获、取消、完成回调、持久化。
 *
 * - API Key 只保存在内存,绝不写入磁盘(持久化文件与报告都不含 key);
 * - 任务完成后可回调 webhook(可选): POST {event:'job.finished', job:{...}};
 * - 服务重启时: 运行中/排队任务标记为 interrupted,历史任务与报告保留。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runAudit, TOOL_VERSION } from '../src/run.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_DIR = join(ROOT, 'data')
const REFS_DIR = join(DATA_DIR, 'refs')
const JOBS_FILE = join(DATA_DIR, 'jobs.json')

const STATUS_TEXT = {
  queued: '排队中', running: '运行中', done: '已完成',
  failed: '失败', canceled: '已取消', interrupted: '已中断',
}

export class JobManager {
  constructor({
    maxConcurrent = Number(process.env.WATER_AUDIT_MAX_CONCURRENT ?? 2),
    jobTimeoutMs = Number(process.env.WATER_AUDIT_JOB_TIMEOUT_MS ?? 45 * 60 * 1000),
    maxHistory = 100,
  } = {}) {
    this.maxConcurrent = Math.max(1, maxConcurrent)
    this.jobTimeoutMs = jobTimeoutMs
    this.maxHistory = maxHistory
    this.jobs = new Map()
    this.queue = []
    this.active = new Map() // id -> {abortController, timer}
    mkdirSync(DATA_DIR, { recursive: true })
    mkdirSync(REFS_DIR, { recursive: true })
    this._load()
    this._pump()
  }

  get meta() {
    return {
      tool: `water-audit v${TOOL_VERSION}`,
      maxConcurrent: this.maxConcurrent,
      jobTimeoutMs: this.jobTimeoutMs,
      running: this.active.size,
      queued: this.queue.length,
      presets: {
        quick: '4 格 × 15 采样 + 16k 长上下文(约 150 请求)',
        standard: '8 格 × 25 采样 + 16k/64k 长上下文(约 350 请求)',
        deep: '16 格 × 25 采样 + 16k→400k 长上下文(约 900 请求)',
      },
      suites: [
        { id: 'infra', title: '基础设施指纹' },
        { id: 'tokenizer', title: '分词器指纹' },
        { id: 'identity', title: '身份与知识截止' },
        { id: 'onetoken', title: '单 token 行为指纹' },
        { id: 'capability', title: '能力分层评测' },
        { id: 'longcontext', title: '长上下文一致性' },
        { id: 'stability', title: '稳定性与缓存' },
      ],
    }
  }

  /**
   * 创建审计任务。
   * @param {object} p {baseUrl, apiKey, model, budget, suites, noExec, label, refJson, webhookUrl}
   */
  create(p) {
    const baseUrl = String(p.baseUrl ?? '').trim().replace(/\/+$/, '')
    const apiKey = String(p.apiKey ?? '')
    const model = String(p.model ?? '').trim()
    const budget = ['quick', 'standard', 'deep'].includes(p.budget) ? p.budget : 'standard'
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
    if (!model || /[\s"']/.test(model)) throw new Error('模型 ID 不能为空且不能含空格/引号')
    const allSuites = this.meta.suites.map((s) => s.id)
    let suites = Array.isArray(p.suites) ? p.suites.filter((s) => allSuites.includes(s)) : allSuites
    if (!suites.length) suites = allSuites

    let refPath = null
    if (p.refJson && String(p.refJson).trim()) {
      let parsed
      try { parsed = JSON.parse(String(p.refJson)) } catch { throw new Error('参考指纹不是合法 JSON') }
      if (!parsed?.cells || typeof parsed.cells !== 'object') throw new Error('参考指纹缺少 cells 字段(应由 enroll 子命令生成)')
      refPath = join(REFS_DIR, `ref-${Date.now()}-${randomUUID().slice(0, 6)}.json`)
      writeFileSync(refPath, JSON.stringify(parsed, null, 1), 'utf-8')
    }

    const job = {
      id: randomUUID().slice(0, 8),
      label: String(p.label ?? '').trim().slice(0, 60) || null,
      baseUrl, model, budget, suites,
      noExec: !!p.noExec,
      hasKey: !!apiKey,       // 不落盘,只标记是否提供
      hasRef: !!refPath,
      webhookUrl: p.webhookUrl ? String(p.webhookUrl).trim().slice(0, 300) : null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, durationMs: null,
      error: null,
      verdict: null, suites_: null, usage: null,
      reportDir: null, reportUrl: null,
      log: [],                // 仅内存
    }
    this.jobs.set(job.id, job)
    job._apiKey = apiKey      // 私有字段,持久化时剔除
    job._refPath = refPath
    this.queue.push(job.id)
    this._persist()
    this._pump()
    return this.public(job)
  }

  cancel(id) {
    const job = this.jobs.get(id)
    if (!job) return null
    if (job.status === 'queued') {
      this.queue = this.queue.filter((qid) => qid !== id)
      job.status = 'canceled'
      job.finishedAt = new Date().toISOString()
      this._log(job, '任务在排队时被取消')
      this._persist()
      return this.public(job)
    }
    if (job.status === 'running') {
      this._log(job, '收到取消指令,将在当前探针结束后停止…')
      this.active.get(id)?.abortController.abort()
      return this.public(job)
    }
    return this.public(job)
  }

  remove(id) {
    const job = this.jobs.get(id)
    if (!job) return false
    if (job.status === 'running' || job.status === 'queued') return false
    this.jobs.delete(id)
    this._persist()
    return true
  }

  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((j) => this.public(j)) }

  get(id) {
    const job = this.jobs.get(id)
    return job ? this.public(job, true) : null
  }

  /** 对外视图: 永远不含 apiKey */
  public(job, withLog = false) {
    const { _apiKey, _refPath, log, ...rest } = job
    const view = { ...rest, statusText: STATUS_TEXT[job.status] ?? job.status }
    if (withLog) view.log = job.log
    return view
  }

  // ---------- 内部 ----------
  _log(job, line) {
    job.log.push({ ts: new Date().toISOString(), line: String(line) })
    if (job.log.length > 1200) job.log.splice(0, job.log.length - 1200)
  }

  _pump() {
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()
      const job = this.jobs.get(id)
      if (!job || job.status !== 'queued') continue
      this._run(job)
    }
  }

  _run(job) {
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    const abortController = new AbortController()
    const timer = setTimeout(() => {
      this._log(job, `⏱ 任务超过 ${Math.round(this.jobTimeoutMs / 60000)} 分钟,强制终止`)
      abortController.abort()
    }, this.jobTimeoutMs)
    this.active.set(job.id, { abortController, timer })
    this._log(job, `任务开始: ${job.model} @ ${job.baseUrl} (预算 ${job.budget})`)

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const safeModel = job.model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50)
    const outDir = join(ROOT, 'reports', `${ts}-${safeModel}-${job.id.slice(0, 4)}`)

    runAudit({
      baseUrl: job.baseUrl,
      apiKey: job._apiKey ?? '',
      model: job.model,
      budget: job.budget,
      suites: job.suites,
      refPath: job._refPath,
      noExec: job.noExec,
      outDir,
      signal: abortController.signal,
      log: (line) => this._log(job, line),
    }).then(({ report, outDir }) => {
      job.status = 'done'
      job.verdict = report.verdict
      job.suites_ = report.results.map((r) => ({ id: r.id, title: r.title, status: r.status, confidence: r.confidence, score: r.score, summary: r.summary }))
      job.usage = report.meta.usage
      job.reportDir = outDir
      job.reportUrl = `/reports/${basename(outDir)}/report.html`
      this._log(job, `✓ 完成: ${report.verdict.headline}`)
    }).catch((e) => {
      if (abortController.signal.aborted) {
        job.status = 'canceled'
        job.error = '已取消'
        this._log(job, '任务已取消')
      } else {
        job.status = 'failed'
        job.error = String(e?.message ?? e).slice(0, 400)
        this._log(job, `✗ 失败: ${job.error}`)
      }
    }).finally(() => {
      clearTimeout(timer)
      this.active.delete(job.id)
      job.finishedAt = new Date().toISOString()
      job.durationMs = job.finishedAt && job.startedAt
        ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : null
      this._persist()
      if (job.webhookUrl && (job.status === 'done' || job.status === 'failed')) this._fireWebhook(job)
      this._pump()
    })
  }

  async _fireWebhook(job) {
    try {
      const res = await fetch(job.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'job.finished',
          job: {
            id: job.id, label: job.label, model: job.model, baseUrl: job.baseUrl,
            budget: job.budget, status: job.status, error: job.error,
            verdict: job.verdict, reportUrl: job.reportUrl,
            durationMs: job.durationMs, finishedAt: job.finishedAt,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      this._log(job, `webhook 已回调: HTTP ${res.status}`)
    } catch (e) {
      this._log(job, `webhook 回调失败: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  _persist() {
    const arr = this.list().map((v) => {
      const { log, ...rest } = v
      return rest
    })
    try {
      writeFileSync(JOBS_FILE, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), jobs: arr }, null, 1), 'utf-8')
    } catch { /* 磁盘问题不阻塞审计 */ }
  }

  _load() {
    if (!existsSync(JOBS_FILE)) return
    try {
      const data = JSON.parse(readFileSync(JOBS_FILE, 'utf-8'))
      for (const j of data.jobs ?? []) {
        if (j.status === 'queued' || j.status === 'running') {
          j.status = 'interrupted'
          j.error = '服务重启,任务中断(报告未生成)'
        }
        j.log = []
        this.jobs.set(j.id, j)
      }
      // 裁剪历史
      const all = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      for (const j of all.slice(this.maxHistory)) this.jobs.delete(j.id)
    } catch { /* 损坏的持久化文件: 忽略 */ }
  }
}
