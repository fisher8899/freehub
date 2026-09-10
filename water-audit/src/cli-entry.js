/**
 * CLI 后端: runAudit 的封装 + enroll 命令实现。
 */
import { OpenAiClient } from './http.js'
import { Evidence } from './evidence.js'
import { runAudit, resolveClaimedMeta } from './run.js'
import { enrollReference } from './probes/onetoken.js'

export { runAudit }

export async function enrollPath({ baseUrl, apiKey, model, budget, outPath, concurrency, timeoutMs, log }) {
  const client = new OpenAiClient({ baseUrl, apiKey, model, concurrency, timeoutMs })
  const evidence = new Evidence()
  const claimedMeta = resolveClaimedMeta(model)
  const doc = await enrollReference({ client, evidence, log, budget, claimedMeta, signal: undefined }, outPath)
  const total = Object.values(doc.cells).reduce((s, c) => s + (c.valid ?? 0), 0)
  log(`✓ 参考指纹已保存: ${outPath}`)
  log(`  模型 ${model} · ${Object.keys(doc.cells).length} 格 · 有效样本 ${total} · 协议 ${doc.protocol}`)
  log(`  之后对可疑端点运行: water-audit --base-url <可疑端点> --model ${model} --ref ${outPath}`)
  return doc
}
