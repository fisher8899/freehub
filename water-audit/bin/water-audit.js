#!/usr/bin/env node
/**
 * water-audit CLI
 *
 * 用法:
 *   node bin/water-audit.js --base-url https://api.example.com/v1 \
 *        --api-key sk-xxx --model gpt-4o [--budget quick|standard|deep]
 *        [--ref my-reference.json] [--enroll out.json] [--no-exec]
 *        [--suites infra,tokenizer,identity,onetoken,capability,longcontext,stability]
 *        [--out reports/xxx] [--concurrency 4] [--timeout-ms 60000]
 *
 * 环境变量: WATER_AUDIT_BASE_URL / WATER_AUDIT_API_KEY / WATER_AUDIT_MODEL
 */
import { runAudit, enrollPath } from '../src/cli-entry.js'

const args = process.argv.slice(2)
const get = (name, short) => {
  const i = args.indexOf(`--${name}`)
  if (i >= 0) return args[i + 1]
  if (short) { const j = args.indexOf(`-${short}`); if (j >= 0) return args[j + 1] }
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : undefined
}
const has = (name) => args.includes(`--${name}`)

const baseUrl = get('base-url') ?? process.env.WATER_AUDIT_BASE_URL
const apiKey = get('api-key') ?? process.env.WATER_AUDIT_API_KEY
const model = get('model') ?? process.env.WATER_AUDIT_MODEL

if (!baseUrl || !apiKey || !model) {
  console.error(`water-audit —— 检测一个 OpenAI 兼容 API 是否真的在服务它声称的模型

用法:
  node bin/water-audit.js --base-url https://api.example.com/v1 \\
       --api-key sk-xxx --model gpt-4o [选项]

必填:
  --base-url   OpenAI 兼容 API 根地址(含 /v1)
  --api-key    API Key
  --model      声称的模型名

选项:
  --budget quick|standard|deep   探针规模(默认 standard;deep 约 800+ 次请求)
  --ref <file>                   自采行为指纹参考(enroll 产出,同协议严格比对)
  --enroll <file>                只采集本端点的行为指纹参考并退出(建议对官方端点使用)
  --suites <a,b,c>               只运行指定探针
  --out <dir>                    报告输出目录(默认 reports/<时间>-<模型>/)
  --no-exec                      不在本地执行模型生成的代码(代码题跳过)
  --concurrency <n>              并发数(默认 4)
  --timeout-ms <n>               单请求超时(默认 60000)`)
  process.exit(1)
}

const log = (line) => console.log(line)

try {
  if (get('enroll')) {
    await enrollPath({ baseUrl, apiKey, model, budget: get('budget') ?? 'standard', outPath: get('enroll'), concurrency: Number(get('concurrency') ?? 4), timeoutMs: Number(get('timeout-ms') ?? 60000), log })
    process.exit(0)
  }
  const { report, outDir } = await runAudit({
    baseUrl, apiKey, model,
    budget: get('budget') ?? 'standard',
    refPath: get('ref'),
    outDir: get('out'),
    noExec: has('no-exec'),
    suites: get('suites')?.split(',').map((s) => s.trim()).filter(Boolean),
    concurrency: Number(get('concurrency') ?? 4),
    timeoutMs: Number(get('timeout-ms') ?? 60000),
    log,
  })
  const { statusLabel } = await import('../src/run.js')
  console.log(`\n════════════════════════════════════════`)
  console.log(`总体判定: [${statusLabel(report.verdict.status)}] ${report.verdict.headline}`)
  if (report.verdict.hardEvidence?.length) {
    console.log(`硬证据:`)
    for (const h of report.verdict.hardEvidence) console.log(`  - ${h}`)
  }
  for (const r of report.results) {
    console.log(`  ${pad(r.title, 12)} ${statusLabel(r.status)}${r.score != null ? ` (${r.score})` : ''} — ${clip(r.summary, 90)}`)
  }
  console.log(`报告: ${outDir}/report.html | report.md | evidence.jsonl`)
} catch (e) {
  console.error(`\n✗ 审计失败: ${e?.message ?? e}`)
  if (process.env.DEBUG) console.error(e?.stack)
  process.exit(2)
}

function pad(s, n) { return String(s).padEnd(n, '　') }
function clip(s, n) { return String(s).length > n ? String(s).slice(0, n) + '…' : String(s) }
