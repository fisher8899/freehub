#!/usr/bin/env node
/**
 * 端到端自测: 起 honest / cheater 两个 mock 端点,跑完整审计,断言判定方向。
 * 不需要任何 API key 与外网。
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const results = { pass: 0, fail: 0 }
function check(name, cond, detail = '') {
  if (cond) { results.pass++; console.log(`  ✓ ${name}`) }
  else { results.fail++; console.log(`  ✗ ${name} ${detail}`) }
}

async function waitPort(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: 'Bearer mock' } })
      if (res.ok) return true
    } catch { /* retry */ }
    await delay(100)
  }
  return false
}

function startMock(mode, port) {
  const child = spawn('node', ['test/mock-server.mjs', '--mode', mode, '--port', String(port)], { stdio: 'pipe' })
  child.stderr.on('data', (d) => process.stderr.write(`[mock:${mode}] ${d}`))
  return child
}

const { runAudit, statusLabel } = await import('../src/run.js')

console.log('══ 1. honest 端点(真 gpt-4o 行为) ══')
{
  const mock = startMock('honest', 8801)
  if (!(await waitPort(8801))) { console.error('mock honest 启动失败'); process.exit(1) }
  const { report } = await runAudit({
    baseUrl: 'http://127.0.0.1:8801/v1', apiKey: 'mock-key', model: 'gpt-4o',
    budget: 'quick', noExec: false,
    log: () => {},
  })
  const by = Object.fromEntries(report.results.map((r) => [r.id, r]))
  check('总体判定不是「不符」', report.verdict.status !== 'mismatch', `→ ${report.verdict.status}: ${report.verdict.headline}`)
  check('分词器判定一致', by.tokenizer.status === 'consistent', `→ ${by.tokenizer.status} ${by.tokenizer.summary}`)
  check('行为指纹判定一致', by.onetoken.status === 'consistent', `→ ${by.onetoken.status} ${by.onetoken.summary}`)
  check('能力判定不是「不符」', by.capability.status !== 'mismatch', `→ ${by.capability.status} ${by.capability.summary}`)
  check('稳定性不是「不符」', by.stability.status !== 'mismatch', `→ ${by.stability.status}`)
  check('长上下文一致', by.longcontext.status === 'consistent', `→ ${by.longcontext.status} ${by.longcontext.summary}`)
  mock.kill()
}

console.log('══ 2. cheater 端点(声称 gpt-4o,实为 mini 行为 + cl100k 分词) ══')
{
  const mock = startMock('cheater', 8802)
  if (!(await waitPort(8802))) { console.error('mock cheater 启动失败'); process.exit(1) }
  const { report } = await runAudit({
    baseUrl: 'http://127.0.0.1:8802/v1', apiKey: 'mock-key', model: 'gpt-4o',
    budget: 'quick', noExec: false,
    log: () => {},
  })
  const by = Object.fromEntries(report.results.map((r) => [r.id, r]))
  check('总体判定为「不符」', report.verdict.status === 'mismatch', `→ ${report.verdict.status}: ${report.verdict.headline}`)
  check('分词器判定为不符或可疑', ['mismatch', 'suspicious'].includes(by.tokenizer.status), `→ ${by.tokenizer.status} ${by.tokenizer.summary}`)
  check('行为指纹判定为不符或可疑', ['mismatch', 'suspicious'].includes(by.onetoken.status), `→ ${by.onetoken.status} ${by.onetoken.summary}`)
  check('能力判定为不符或可疑', ['mismatch', 'suspicious'].includes(by.capability.status), `→ ${by.capability.status} ${by.capability.summary}`)
  check('报告硬证据非空', (report.verdict.hardEvidence ?? []).length > 0)
  check('身份自报记录完整(6 问法)', by.identity.raw.identityAnswers.filter((a) => a.includes('GPT-4o') || a.includes('OpenAI')).length >= 4)
  console.log(`  cheater 总体: [${statusLabel(report.verdict.status)}] ${report.verdict.headline}`)
  mock.kill()
}

console.log('══ 3. 证据完整性 ══')
{
  const mock = startMock('honest', 8803)
  if (!(await waitPort(8803))) { console.error('mock 启动失败'); process.exit(1) }
  const { report, outDir } = await runAudit({
    baseUrl: 'http://127.0.0.1:8803/v1', apiKey: 'mock-key', model: 'gpt-4o',
    budget: 'quick', suites: ['infra', 'tokenizer'], outDir: 'reports/selftest-evidence',
    log: () => {},
  })
  check('summary.json 存在', (await import('node:fs')).existsSync(`${outDir}/summary.json`))
  check('report.html 存在', (await import('node:fs')).existsSync(`${outDir}/report.html`))
  check('evidence.jsonl 存在', (await import('node:fs')).existsSync(`${outDir}/evidence.jsonl`))
  check('每个结论都有证据编号', report.results.every((r) => (r.evidenceIds ?? []).length > 0))
  mock.kill()
}

console.log(`\n自测结果: ${results.pass} 通过 / ${results.fail} 失败`)
process.exit(results.fail ? 1 : 0)
