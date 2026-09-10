/**
 * Markdown 报告生成。所有结论均引用证据编号(E-xxxx),可在 evidence.jsonl 查证。
 */
import { statusLabel } from '../run.js'

export function renderMarkdown(report) {
  const { meta, verdict, results } = report
  const L = []
  const STATUS_ICON = { consistent: '✅', suspicious: '⚠️', mismatch: '❌', inconclusive: '❔', na: '➖' }

  L.push(`# 模型注水审计报告`)
  L.push('')
  L.push(`| 项目 | 值 |`)
  L.push(`| --- | --- |`)
  L.push(`| 端点 | \`${meta.baseUrl}\` |`)
  L.push(`| 声称模型 | \`${meta.model}\`${meta.claimedModelKnown ? '' : '(参考库未收录,绝对判定能力受限)'}` + ' |')
  L.push(`| 审计时间 | ${meta.generatedAt} |`)
  L.push(`| 预算档位 | ${meta.budget} |`)
  L.push(`| 工具 | ${meta.tool} (Node ${meta.node}) |`)
  L.push(`| 用量 | 请求 ${meta.usage.requests} 次 / prompt ${meta.usage.promptTokens} tok / completion ${meta.usage.completionTokens} tok / 失败 ${meta.usage.errors} 次 |`)
  L.push('')
  L.push(`## 总体判定: ${STATUS_ICON[verdict.status] ?? ''} ${statusLabel(verdict.status)}`)
  L.push('')
  L.push(`**${verdict.headline}**`)
  L.push('')
  if (verdict.hardEvidence?.length) {
    L.push(`**硬证据清单:**`)
    for (const h of verdict.hardEvidence) L.push(`- ${h}`)
    L.push('')
  }
  L.push('> 判定规则(完全透明): 任一硬证据成立 → 「不符」;无可疑 → 各维度均一致 → 「未发现注水证据」;存在可疑信号 → 「可疑」;过半维度证据不足 → 「无法判定」。「未发现注水证据」≠ 证明没注水。')
  L.push('')

  L.push(`## 各维度结果`)
  L.push('')
  L.push(`| 维度 | 判定 | 置信度 | 评分* | 摘要 |`)
  L.push(`| --- | --- | --- | --- | --- |`)
  for (const r of results) {
    L.push(`| ${r.title} | ${STATUS_ICON[r.status] ?? ''} ${statusLabel(r.status)} | ${r.confidence ?? '-'} | ${r.score != null ? r.score : '-'} | ${r.summary.replaceAll('|', '\\|').slice(0, 160)} |`)
  }
  L.push('')
  L.push('\\* 评分仅当存在数据可算的公式时给出,公式见各维度小节;无公式依据的不打分。')
  L.push('')

  for (const r of results) {
    L.push(`## ${r.title}`)
    L.push('')
    L.push(`**判定: ${STATUS_ICON[r.status] ?? ''} ${statusLabel(r.status)}**(置信度: ${r.confidence ?? '-'})`)
    L.push('')
    L.push(r.summary)
    L.push('')
    if (r.scoreFormula) {
      L.push(`- 评分: ${r.score != null ? `**${r.score}/100**` : '不适用'} — 公式: ${r.scoreFormula}`)
      L.push('')
    }
    if (r.metrics && Object.keys(r.metrics).length) {
      L.push('**关键指标:**')
      L.push('')
      L.push('```json')
      const slim = slimMetrics(r)
      L.push(JSON.stringify(slim, null, 1).slice(0, 3000))
      L.push('```')
      L.push('')
    }
    if (r.findings?.length) {
      L.push('**发现:**')
      L.push('')
      for (const f of r.findings) {
        const icon = { mismatch: '❌', suspicious: '⚠️', warn: '⚠️', info: 'ℹ️', note: '📝', detail: '  ·' }[f.level] ?? '-'
        L.push(`- ${icon} ${f.text}`)
      }
      L.push('')
    }
    if (r.raw?.perCell?.length) {
      L.push('**逐格 JSD(与参考比对):**')
      L.push('')
      L.push('| 格 | JSD | 本侧有效 | 参考侧 |')
      L.push('| --- | --- | --- | --- |')
      for (const c of r.raw.perCell.slice(0, 16)) {
        L.push(`| ${c.cellId} | ${c.jsd.toFixed(3)} | ${c.validSelf} | ${c.validRef} |`)
      }
      L.push('')
    }
    if (r.raw?.results && r.id === 'capability') {
      L.push('**逐题明细:**')
      L.push('')
      L.push('| 题号 | 层 | 主题 | 判定 | 期望 | 实际 |')
      L.push('| --- | --- | --- | --- | --- | --- |')
      for (const it of r.raw.results) {
        const icon = { pass: '✓', fail: '✗', partial: '◐', error: '!', skipped: '-' }[it.outcome] ?? '?'
        L.push(`| ${it.id} | ${it.tier} | ${it.subject} | ${icon} | ${String(it.expected).slice(0, 24)} | ${String(it.actual ?? '').slice(0, 36).replaceAll('|', '\\|')} |`)
      }
      L.push('')
    }
    const evRefs = r.evidenceIds?.length ? r.evidenceIds.join(', ') : '(无)'
    L.push(`**证据编号:** ${evRefs}`)
    L.push('')
  }

  L.push(`## 无法确认的事项(诚实声明)`)
  L.push('')
  for (const line of honestLimits(report)) L.push(`- ${line}`)
  L.push('')
  L.push(`## 方法与阈值出处`)
  L.push('')
  L.push('- 单 token 行为指纹与阈值(0.25/0.35,基线 0.140/0.227/0.463): Bruckner, *One Token Is Enough*, arXiv:2607.10252;参考数据 Zenodo DOI 10.5281/zenodo.21278557(CC-BY-4.0),经 llm-fingerprint-detector 重构,采集于 OpenRouter,2026-07-08。')
  L.push('- 分词器指纹: 对 36 条规范字符串的 `usage.prompt_tokens` 做锚点相对差值匹配;OpenAI 词表/正则来自 tiktoken 官方(正则原文于 tiktoken_ext/openai_public.py),Llama-3/4 词表来自 Meta 官方(PyPI llama-models)。')
  L.push('- 能力分数带: 见 `src/references/models.json`,逐条注明官方出处与截至日期;本项目题集规模小,仅用于粗粒度分层判定。')
  L.push('- 统计: Wilson 95% 置信区间;JSD 为 base-2。')
  L.push('- 局限: 服务商可伪造 usage/身份话术;行为参考存在渠道与时间漂移;长上下文探针依赖服务端诚实报告 prompt_tokens。所有结论均为统计证据,非法律意义上的证明。')
  L.push('')
  L.push(`---`)
  L.push(`*本报告由 water-audit 自动生成;全部原始交互见 evidence.jsonl(${report.meta.usage.requests} 次请求)。*`)
  return L.join('\n')
}

function slimMetrics(r) {
  const m = r.metrics ?? {}
  const out = {}
  for (const [k, v] of Object.entries(m)) {
    const s = JSON.stringify(v)
    if (s && s.length > 900) out[k] = s.slice(0, 60) + `…(完整值见 evidence.jsonl, ${s.length} 字节)`
    else out[k] = v
  }
  return out
}

function honestLimits(report) {
  const lines = []
  const byId = Object.fromEntries(report.results.map((r) => [r.id, r]))
  if (!report.meta.claimedModelKnown) lines.push(`参考库未收录声称模型 "${report.meta.model}" 的官方元数据与公开分数带:能力维度只记录实测,不做绝对判定;行为指纹仅做最近邻识别。`)
  if (byId.onetoken?.metrics?.verdict === 'no-ref') lines.push('没有该声称模型的行为指纹参考(可用官方 key 运行 `enroll` 子命令自采,再做同协议严格比对 —— 这是最可靠的路径)。')
  if (byId.tokenizer?.status === 'na' || byId.tokenizer?.status === 'inconclusive') lines.push('分词器维度证据不足:可能是限流、不支持 usage 或请求失败;也可能端点伪造 usage。')
  if (report.meta.budget !== 'deep') lines.push('本次为非 deep 预算,采样量与题量有限;统计功效不足时请用 `--budget deep` 复测。')
  lines.push('身份自报/知识截止可被服务商系统提示词伪装;logprobs 缺失时无法做概率级劣化检测;usage 数字可被伪造。这些环节的结论均已按「低/中」置信度标注。')
  if (byId.longcontext?.status === 'inconclusive') lines.push('长上下文维度未取得有效数据,声称的上下文长度未经实测验证。')
  return lines
}
