/**
 * water-audit Web 控制台服务器(零依赖, Node ≥ 18.17)。
 *
 *   node server/index.js          # 默认 0.0.0.0:8620
 *   WATER_AUDIT_PORT=9000 node server/index.js
 *
 * 安全模型(本地工具):
 *  - API Key 仅保存在进程内存,不落盘;日志与报告均不含 key;
 *  - /reports 只读暴露报告目录;任务持久化文件不含 key;
 *  - 如需公网访问,请自行加反向代理鉴权。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize, extname, basename } from 'node:path'
import { JobManager } from './jobs.js'
import { TOOL_VERSION } from '../src/run.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const WEB_DIR = join(ROOT, 'web')
const REPORTS_DIR = join(ROOT, 'reports')

const PORT = Number(process.env.WATER_AUDIT_PORT ?? 8620)
const HOST = process.env.WATER_AUDIT_HOST ?? '0.0.0.0'

const manager = new JobManager()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/jsonl; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj))

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/** 只读提供 reports/ 目录内容(防目录穿越) */
function serveReportFile(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/reports\//, ''))
  const target = normalize(join(REPORTS_DIR, rel))
  if (!target.startsWith(normalize(REPORTS_DIR))) return json(res, 403, { error: '禁止访问' })
  if (!existsSync(target) || !statSync(target).isFile()) return json(res, 404, { error: '文件不存在' })
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  try {
    send(res, 200, readFileSync(target), type)
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) })
  }
}

function listReports() {
  if (!existsSync(REPORTS_DIR)) return []
  const out = []
  for (const name of readdirSync(REPORTS_DIR)) {
    const dir = join(REPORTS_DIR, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const summaryPath = join(dir, 'summary.json')
      let meta = { dir: name }
      if (existsSync(summaryPath)) {
        const s = JSON.parse(readFileSync(summaryPath, 'utf-8'))
        meta = {
          dir: name,
          model: s.meta?.model, baseUrl: s.meta?.baseUrl, budget: s.meta?.budget,
          generatedAt: s.meta?.generatedAt, usage: s.meta?.usage,
          verdict: s.verdict ? { status: s.verdict.status, headline: s.verdict.headline } : null,
          suites: (s.results ?? []).map((r) => ({ id: r.id, title: r.title, status: r.status, score: r.score })),
        }
      }
      out.push(meta)
    } catch { /* 跳过坏目录 */ }
  }
  out.sort((a, b) => (b.generatedAt ?? '').localeCompare(a.generatedAt ?? ''))
  return out
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      return res.end()
    }

    // ---------- API ----------
    if (path === '/api/meta') return json(res, 200, { ...manager.meta, port: PORT })
    if (path === '/api/jobs' && req.method === 'GET') return json(res, 200, manager.list())
    if (path === '/api/jobs' && req.method === 'POST') {
      let body
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { error: '请求体不是合法 JSON' }) }
      try {
        const job = manager.create(body)
        return json(res, 200, job)
      } catch (e) {
        return json(res, 400, { error: String(e?.message ?? e) })
      }
    }
    const jobMatch = path.match(/^\/api\/jobs\/([a-z0-9-]+)$/i)
    if (jobMatch && req.method === 'GET') {
      const job = manager.get(jobMatch[1])
      return job ? json(res, 200, job) : json(res, 404, { error: '任务不存在' })
    }
    const cancelMatch = path.match(/^\/api\/jobs\/([a-z0-9-]+)\/cancel$/i)
    if (cancelMatch && req.method === 'POST') {
      const job = manager.cancel(cancelMatch[1])
      return job ? json(res, 200, job) : json(res, 404, { error: '任务不存在' })
    }
    if (jobMatch && req.method === 'DELETE') {
      const ok = manager.remove(jobMatch[1])
      return ok ? json(res, 200, { ok: true }) : json(res, 400, { error: '仅可删除已结束的任务' })
    }
    if (path === '/api/reports' && req.method === 'GET') return json(res, 200, listReports())
    if (path.startsWith('/reports/')) return serveReportFile(req, res, path)

    // ---------- 静态 UI ----------
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return send(res, 200, readFileSync(join(WEB_DIR, 'index.html')), 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && path === '/favicon.ico') return send(res, 204, '')

    json(res, 404, { error: 'Not Found' })
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`water-audit 控制台 v${TOOL_VERSION}`)
  console.log(`  → http://localhost:${PORT}  (绑定 ${HOST}; 局域网/预览环境经代理访问)`)
  console.log(`  并发任务上限 ${manager.maxConcurrent},单任务超时 ${Math.round(manager.jobTimeoutMs / 60000)} 分钟`)
  console.log(`  报告目录: ${REPORTS_DIR}`)
  console.log(`  提示: API Key 仅保存在内存,不落盘`)
})
