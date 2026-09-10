/**
 * 自包含 HTML 报告(内联样式+内联 SVG 条形图,无外部 CDN,离线可看)。
 */
import { statusLabel } from '../run.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const STATUS_STYLE = {
  consistent: { bg: '#e6f7ed', fg: '#0a7a3d', label: '一致' },
  suspicious: { bg: '#fff6e0', fg: '#9a6b00', label: '可疑' },
  mismatch: { bg: '#fde8e8', fg: '#b42318', label: '不符' },
  inconclusive: { bg: '#eef1f6', fg: '#4a5568', label: '无法判定' },
  na: { bg: '#f4f4f5', fg: '#71717a', label: '不适用' },
}

export function renderHtml(report) {
  const { meta, verdict, results } = report
  const badge = (s) => {
    const st = STATUS_STYLE[s] ?? STATUS_STYLE.na
    return `<span class="badge" style="background:${st.bg};color:${st.fg}">${st.label}</span>`
  }

  const dimRows = results.map((r) => `
    <tr>
      <td><a href="#p-${esc(r.id)}">${esc(r.title)}</a></td>
      <td>${badge(r.status)}</td>
      <td>${esc(r.confidence ?? '-')}</td>
      <td>${r.score != null ? bar(r.score) : '<span class="dim">—</span>'}</td>
      <td class="summary">${esc(r.summary)}</td>
    </tr>`).join('')

  const sections = results.map((r) => {
    const metrics = r.metrics && Object.keys(r.metrics).length
      ? `<details><summary>关键指标(JSON,超长字段已截断,完整值见 evidence.jsonl)</summary><pre>${esc(truncateJson(r.metrics, 1200))}</pre></details>` : ''
    const findings = r.findings?.length ? `<ul class="findings">${r.findings.map((f) => `<li class="${esc(f.level)}">${esc(f.text)}</li>`).join('')}</ul>` : ''
    let extra = ''
    if (r.raw?.perCell?.length) {
      extra += `<details open><summary>逐格 JSD</summary><table class="grid"><tr><th>格</th><th>JSD</th><th>本侧</th><th>参考侧</th></tr>${r.raw.perCell.slice(0, 16).map((c) => `<tr><td>${esc(c.cellId)}</td><td>${jsdBar(c.jsd)}</td><td>${c.validSelf}</td><td>${c.validRef}</td></tr>`).join('')}</table></details>`
    }
    if (r.raw?.results && r.id === 'capability') {
      extra += `<details open><summary>逐题明细</summary><table class="grid"><tr><th>题号</th><th>层</th><th>主题</th><th>判定</th><th>期望</th><th>实际</th></tr>${r.raw.results.map((it) => {
        const ok = { pass: '✓', fail: '✗', partial: '◐', error: '!', skipped: '-' }[it.outcome] ?? '?'
        const cls = { pass: 'ok', fail: 'no', partial: 'mid', error: 'mid', skipped: 'dim' }[it.outcome] ?? 'dim'
        return `<tr><td>${esc(it.id)}</td><td>${esc(it.tier)}</td><td>${esc(it.subject)}</td><td class="${cls}">${ok}</td><td>${esc(it.expected).slice(0, 40)}</td><td>${esc(it.actual).slice(0, 60)}</td></tr>`
      }).join('')}</table></details>`
    }
    const formula = r.scoreFormula ? `<p class="formula">评分: <b>${r.score != null ? r.score + '/100' : '不适用'}</b> — ${esc(r.scoreFormula)}</p>` : ''
    return `<section id="p-${esc(r.id)}">
      <h2>${esc(r.title)} ${badge(r.status)} <small>置信度: ${esc(r.confidence ?? '-')}</small></h2>
      <p>${esc(r.summary)}</p>
      ${formula}
      ${metrics}
      ${findings}
      ${extra}
      <p class="ev">证据编号: ${esc((r.evidenceIds ?? []).join(', ') || '(无)')}</p>
    </section>`
  }).join('')

  const hardList = verdict.hardEvidence?.length
    ? `<div class="hard"><b>硬证据清单</b><ul>${verdict.hardEvidence.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>` : ''

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>模型注水审计报告 · ${esc(meta.model)}</title>
<style>
:root{--ink:#1a202c;--sub:#5a6472;--line:#e3e7ee;--code:#f6f8fa}
*{box-sizing:border-box}
body{font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);max-width:980px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;margin:0 0 6px} h2{font-size:19px;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h2 small{font-weight:400;color:var(--sub);font-size:12px}
table{border-collapse:collapse;width:100%} th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top;font-size:13.5px}
th{background:var(--code)}
.badge{display:inline-block;padding:1px 10px;border-radius:20px;font-size:12.5px;font-weight:600;white-space:nowrap}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 24px;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:16px 0}
.meta div b{color:var(--sub);font-weight:500;margin-right:6px}
.verdict{border-left:4px solid #334e68;background:#f0f4f8;border-radius:0 10px 10px 0;padding:14px 18px;margin:18px 0}
.verdict.big-mismatch{border-color:#b42318;background:#fdf1f0}
.verdict.big-suspicious{border-color:#9a6b00;background:#fff9ec}
.verdict.big-consistent{border-color:#0a7a3d;background:#eefaf2}
.dim{color:#9aa3af}
.summary{font-size:12.5px;color:var(--sub)}
.barwrap{display:inline-block;width:120px;background:#eef1f6;border-radius:4px;vertical-align:middle;height:14px;overflow:hidden}
.barfill{height:100%;background:#3b82f6}
.findings li{margin:5px 0}
.findings .mismatch{color:#b42318} .findings .suspicious,.findings .warn{color:#9a6b00} .findings .note{color:var(--sub)}
.formula{background:var(--code);border-radius:6px;padding:8px 12px;font-size:13px}
.ev{color:#9aa3af;font-size:12px}
details{margin:10px 0} summary{cursor:pointer;color:#33557a;font-size:13.5px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px 14px;overflow:auto;font-size:12px}
.hard{background:#fdf1f0;border:1px solid #f2c1bd;border-radius:8px;padding:10px 16px;margin:12px 0}
.grid td{font-size:12.5px}
.ok{color:#0a7a3d;font-weight:700} .no{color:#b42318;font-weight:700} .mid{color:#9a6b00;font-weight:700}
footer{margin-top:48px;color:#9aa3af;font-size:12px;border-top:1px solid var(--line);padding-top:14px}
ul.rules{color:var(--sub);font-size:13px}
</style></head><body>
<h1>模型注水审计报告</h1>
<div class="meta">
  <div><b>端点</b><code>${esc(meta.baseUrl)}</code></div>
  <div><b>声称模型</b><code>${esc(meta.model)}</code>${meta.claimedModelKnown ? '' : ' <span class="dim">(参考库未收录)</span>'}</div>
  <div><b>审计时间</b>${esc(meta.generatedAt)}</div>
  <div><b>预算</b>${esc(meta.budget)}</div>
  <div><b>工具</b>${esc(meta.tool)}</div>
  <div><b>用量</b>${meta.usage.requests} 次请求 / ${meta.usage.promptTokens} prompt tok / ${meta.usage.completionTokens} completion tok / ${meta.usage.errors} 次失败</div>
</div>
<div class="verdict big-${esc(verdict.status)}">
  <div style="font-size:18px;font-weight:700">总体判定: ${badge(verdict.status)} ${esc(verdict.headline)}</div>
  ${hardList}
  <ul class="rules">
    <li>判定规则(透明): 任一硬证据成立 → <b>不符</b>;存在可疑信号 → <b>可疑</b>;各维度均一致 → <b>未发现注水证据</b>;过半维度无有效数据 → <b>无法判定</b>。</li>
    <li>「未发现注水证据」≠ 证明没注水;所有结论为统计证据,非绝对证明。</li>
  </ul>
</div>
<h2>各维度结果</h2>
<table>
<tr><th>维度</th><th>判定</th><th>置信度</th><th>评分</th><th>摘要</th></tr>
${dimRows}
</table>
${sections}
<h2>无法确认的事项(诚实声明)</h2>
<ul>
${honestLimitsHtml(report)}
</ul>
<h2>方法与阈值出处</h2>
<ul>
<li>单 token 行为指纹与阈值(≤0.25 match / >0.35 mismatch;基线 0.140 同源自比 / 0.227 跨服务商 / 0.463 不同模型):Bruckner, <i>One Token Is Enough</i>, arXiv:2607.10252;参考数据 Zenodo DOI 10.5281/zenodo.21278557(CC-BY-4.0),llm-fingerprint-detector 重构,OpenRouter 渠道,2026-07-08。</li>
<li>分词器指纹:36 条规范字符串的 <code>usage.prompt_tokens</code> 锚点相对差值匹配;OpenAI 正则/词表来自 tiktoken 官方,Llama-3/4 词表来自 Meta 官方(PyPI llama-models)。</li>
<li>能力分数带:<code>src/references/models.json</code>,逐条注明官方出处与截至日期;题集规模小,仅作粗粒度分层判定。</li>
<li>统计:Wilson 95% 置信区间;JSD 为 base-2。</li>
</ul>
<footer>water-audit 自动生成 · 全部原始交互 ${meta.usage.requests} 次见 evidence.jsonl · ${esc(meta.generatedAt)}</footer>
</body></html>`
}

function bar(score) {
  const w = Math.max(0, Math.min(100, score))
  const color = w >= 80 ? '#0a7a3d' : w >= 60 ? '#9a6b00' : '#b42318'
  return `<span class="barwrap"><span class="barfill" style="width:${w}%;background:${color}"></span></span> <b style="font-size:12px">${w}</b>`
}

function jsdBar(v) {
  const pct = Math.max(0, Math.min(100, v * 100))
  const color = v <= 0.25 ? '#0a7a3d' : v <= 0.35 ? '#9a6b00' : '#b42318'
  return `<span class="barwrap" style="width:80px"><span class="barfill" style="width:${pct}%;background:${color}"></span></span> ${v.toFixed(3)}`
}

function truncateJson(obj, max) {
  const j = JSON.stringify(obj, null, 1)
  return j.length > max * 6 ? j.slice(0, max * 6) + '\n…(截断)' : j
}

function honestLimitsHtml(report) {
  const lines = []
  const byId = Object.fromEntries(report.results.map((r) => [r.id, r]))
  if (!report.meta.claimedModelKnown) lines.push(`参考库未收录声称模型 "${esc(report.meta.model)}" 的官方元数据与公开分数带:能力维度只记录实测,不做绝对判定;行为指纹仅做最近邻识别。`)
  if (byId.onetoken?.metrics?.verdict === 'no-ref') lines.push('没有该声称模型的行为指纹参考:可用官方 key 运行 <code>enroll</code> 自采参考,再做同协议严格比对(最可靠路径)。')
  if (byId.tokenizer && ['na', 'inconclusive'].includes(byId.tokenizer.status)) lines.push('分词器维度证据不足:限流/不支持 usage/请求失败,或端点伪造 usage。')
  if (report.meta.budget !== 'deep') lines.push('本次为非 deep 预算,采样量有限;统计功效不足请用 <code>--budget deep</code> 复测。')
  lines.push('身份自报/知识截止可被服务商系统提示词伪装;logprobs 缺失时无法做概率级劣化检测;usage 数字可被伪造。相关结论均按「低/中」置信度标注。')
  if (byId.longcontext?.status === 'inconclusive') lines.push('长上下文维度未取得有效数据,声称的上下文长度未经实测验证。')
  return lines.map((l) => `<li>${l}</li>`).join('')
}
