/**
 * 能力分层评测探针(证据化打分)。
 *
 *  - 题库: src/references/capability-items.json(全部答案确定,可本地复核);
 *  - 判分: 全部程序化(数字提取/选项/包含/JSON解析/代码子进程执行),零主观;
 *  - 统计: 每层命中率 + Wilson 95% 置信区间;
 *  - 判定: 与声称模型的公开基准「分数带」(models.json, 注明出处与截至日期)
 *          比对。无公开数据的声称模型 → 如实标注「不作绝对判定,仅记录实测」。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { STATUS, result } from '../evidence.js'
import { wilsonCI } from '../stats.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ITEMS = JSON.parse(readFileSync(join(HERE, '../references/capability-items.json'), 'utf-8')).items

const TIER_LABELS = { E: '基础', M: '中等', H: '困难(竞赛级)', F: '长尾/精确执行', D: '劣化信号' }
const MAX_TOKENS = { E: 200, M: 400, H: 900, F: 200, D: 120 }

export async function probeCapability(ctx) {
  const { client, evidence, log, claimedMeta, noExec } = ctx
  const evIds = []
  const results = []

  const items = noExec ? ITEMS.filter((it) => it.answerType !== 'code') : ITEMS
  if (noExec) log('  [capability] --no-exec: 跳过代码执行类题目')

  let done = 0
  await client.pool(items.map((item) => async () => {
    const rec = await askAndGrade(client, item, evidence)
    results.push(rec)
    done++
    if (done % 5 === 0 || done === items.length) log(`  [capability] 进度 ${done}/${items.length}`)
    return true
  }), Math.min(client.concurrency, 4))
  results.sort((a, b) => a.id.localeCompare(b.id))
  evIds.push(evidence.add('capability.runs', { runs: results }))

  // 分层统计
  const tiers = {}
  for (const tier of ['E', 'M', 'H', 'F', 'D']) {
    const rs = results.filter((r) => r.tier === tier && r.outcome !== 'error' && r.outcome !== 'skipped')
    const k = rs.filter((r) => r.outcome === 'pass').length
    const n = rs.length
    if (!n) continue
    const [lo, hi] = wilsonCI(k, n)
    const band = claimedMeta?.bands?.[`tier${tier}`] ?? null
    let verdict = 'inconclusive'
    let verdictNote = ''
    if (band && band.floor != null && tier !== 'D') {
      if (n < 5) { verdict = 'inconclusive'; verdictNote = '样本过少' }
      else if (lo >= band.floor) { verdict = 'pass'; verdictNote = `Wilson 下限 ${(lo * 100).toFixed(0)}% ≥ 公开带下限 ${(band.floor * 100).toFixed(0)}%` }
      else if (k / n >= band.floor) { verdict = 'borderline'; verdictNote = `点估计达标但置信区间未达(下限 ${(lo * 100).toFixed(0)}%)` }
      else if (k / n >= band.floor * 0.6) { verdict = 'low'; verdictNote = `实测 ${k}/${n} = ${((k / n) * 100).toFixed(0)}%,低于公开带下限 ${(band.floor * 100).toFixed(0)}%` }
      else { verdict = 'far-below'; verdictNote = `实测仅 ${k}/${n} = ${((k / n) * 100).toFixed(0)}%,远低于公开带下限 ${(band.floor * 100).toFixed(0)}% —— 强烈提示能力与声称模型不符` }
    } else if (tier === 'D') {
      verdict = k / n >= 0.75 ? 'pass' : k / n >= 0.5 ? 'low' : 'far-below'
      verdictNote = `劣化信号题 ${k}/${n}(计数/大数算术,量化或小模型常见失分点)`
    } else {
      verdictNote = '声称模型无可靠公开分数带,不作绝对判定,仅记录实测'
    }
    tiers[tier] = {
      label: TIER_LABELS[tier],
      accuracy: n ? k / n : null,
      k, n,
      wilson95: [+lo.toFixed(3), +hi.toFixed(3)],
      band: band ? { floor: band.floor, source: band.source, asOf: band.asOf } : null,
      verdict,
      verdictNote,
    }
  }

  const findings = []
  for (const [tier, t] of Object.entries(tiers)) {
    if (t.verdict === 'far-below') findings.push({ level: 'mismatch', text: `「${t.label}」层实测 ${(t.accuracy * 100).toFixed(0)}%,${t.verdictNote}` })
    else if (t.verdict === 'low') findings.push({ level: 'suspicious', text: `「${t.label}」层实测 ${(t.accuracy * 100).toFixed(0)}%,${t.verdictNote}` })
    else if (t.verdict === 'pass') findings.push({ level: 'info', text: `「${t.label}」层达标: ${t.verdictNote}` })
    else findings.push({ level: 'info', text: `「${t.label}」层: ${t.verdictNote}` })
  }
  const failed = results.filter((r) => r.outcome === 'fail')
  for (const f of failed.slice(0, 6)) findings.push({ level: 'detail', text: `未通过 ${f.id}(${f.subject}): 期望「${f.expected}」,得到「${String(f.actual).slice(0, 60)}」` })

  const hardFails = Object.values(tiers).filter((t) => t.verdict === 'far-below').length
  const lowFails = Object.values(tiers).filter((t) => t.verdict === 'low').length
  let status = STATUS.CONSISTENT
  if (hardFails >= 1) status = STATUS.SUSPICIOUS
  if (hardFails >= 2) status = STATUS.MISMATCH
  else if (lowFails >= 2 && status === STATUS.CONSISTENT) status = STATUS.SUSPICIOUS
  if (Object.keys(tiers).length === 0) status = STATUS.INCONCLUSIVE

  const summary = Object.entries(tiers).map(([tier, t]) => `${t.label}: ${t.k}/${t.n}(${(t.accuracy * 100).toFixed(0)}%, 95%CI ${t.wilson95.map((x) => (x * 100).toFixed(0) + '%').join('-')})`).join('; ')

  return result({
    id: 'capability', title: '能力分层评测', status, confidence: '中',
    summary,
    score: tiers.E && tiers.E.accuracy != null ? Math.round((Object.values(tiers).reduce((s, t) => s + t.accuracy, 0) / Object.keys(tiers).length) * 100) : null,
    scoreFormula: '各层命中率的算术平均(仅汇总展示;判定依据是逐层与公开分数带的比较,不是这个平均分)',
    metrics: { tiers }, findings, evidenceIds: evIds, raw: { results },
  })
}

async function askAndGrade(client, item, evidence, noExec) {
  let answer = null
  let err = null
  try {
    const r = await client.chat({
      messages: [{ role: 'user', content: item.prompt }],
      temperature: 0,
      max_tokens: MAX_TOKENS[item.tier] ?? 400,
    }, { retries: 1 })
    answer = r.content
  } catch (e) {
    err = String(e?.message || e)
  }
  if (answer == null) return { id: item.id, tier: item.tier, subject: item.subject, expected: item.answer ?? '代码测试', actual: '', outcome: 'error', detail: err, answer: '' }
  if (item.answerType === 'code') {
    if (noExec) return { id: item.id, tier: item.tier, subject: item.subject, expected: '代码测试', actual: '(未执行)', outcome: 'skipped', detail: '--no-exec', answer: String(answer).slice(0, 500) }
    const graded = await execCodeTests(item, answer)
    return { id: item.id, tier: item.tier, subject: item.subject, expected: `${item.tests.length} 项代码测试`, actual: String(graded.actual ?? ''), outcome: graded.outcome, detail: graded.detail, answer: String(answer).slice(0, 500) }
  }
  const grade = gradeItem(item, answer)
  return {
    id: item.id, tier: item.tier, subject: item.subject,
    expected: item.answer ?? '',
    actual: String(grade.actual ?? '').slice(0, 200),
    outcome: grade.outcome,
    detail: grade.detail ?? null,
    answer: String(answer).slice(0, 500),
  }
}

// ---------- 判分器(全部确定性) ----------
export function gradeItem(item, answer) {
  const text = String(answer ?? '')
  switch (item.answerType) {
    case 'number': return gradeNumber(text, item.answer)
    case 'choice': {
      const m = text.match(/\b([A-D])\b|([A-D])[.、::]/i)
      const letter = (m ? (m[1] ?? m[2]) : null)?.toUpperCase()
      if (letter && letter === item.answer.toUpperCase()) return { outcome: 'pass', actual: letter }
      if ((item.acceptContains ?? []).some((a) => text.includes(a))) return { outcome: 'pass', actual: text.trim().slice(0, 40) }
      return { outcome: letter ? 'fail' : text.trim() ? 'fail' : 'empty', actual: letter ?? text.trim().slice(0, 40) }
    }
    case 'contains': return text.includes(item.answer) ? { outcome: 'pass', actual: text.slice(0, 40) } : { outcome: 'fail', actual: text.slice(0, 40) }
    case 'containsAny': return item.answer.some((a) => text.includes(a)) ? { outcome: 'pass', actual: text.slice(0, 40) } : { outcome: 'fail', actual: text.slice(0, 40) }
    case 'containsNumber': {
      const digits = item.answer
      const variants = [digits, Number(digits).toLocaleString('en-US'), digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')]
      return variants.some((v) => text.includes(v)) ? { outcome: 'pass', actual: text.slice(-40) } : { outcome: 'fail', actual: text.slice(-40) }
    }
    case 'probability': {
      const v = parseProbability(text)
      if (v === null) return { outcome: 'fail', actual: text.slice(0, 40) }
      const ok = Math.abs(v - Number(item.answer)) <= (item.tolerance ?? 0.02)
      return { outcome: ok ? 'pass' : 'fail', actual: String(v) }
    }
    case 'hex': {
      const m = text.match(/([0-9a-fA-F]{2,8})/)
      const h = m?.[1]
      const ok = h && parseInt(h, 16) === parseInt(item.answer, 16)
      return { outcome: ok ? 'pass' : 'fail', actual: h ?? text.slice(0, 40) }
    }
    case 'string': {
      const clean = text.toLowerCase().replace(/[^a-z\u4e00-\u9fff]/g, '')
      const want = item.answer.toLowerCase()
      return clean === want ? { outcome: 'pass', actual: text.slice(0, 40) } : { outcome: 'fail', actual: text.slice(0, 40) }
    }
    case 'exact': {
      const got = text.trim().replace(/[\s"'`]/g, '')
      return got === item.answer ? { outcome: 'pass', actual: got } : { outcome: 'fail', actual: text.slice(0, 60) }
    }
    case 'jsonColor': {
      const j = tryParseJSON(text)
      if (!j) return { outcome: 'fail', actual: text.slice(0, 60) }
      const keys = Object.keys(j)
      const val = j.color ?? j.Color
      const ok = keys.length === 1 && keys[0] === 'color' && typeof val === 'string' && /^[a-z]+$/i.test(val)
      return ok ? { outcome: 'pass', actual: text.slice(0, 60) } : { outcome: 'fail', actual: text.slice(0, 60) }
    }
    case 'code': return { outcome: 'pending-exec', actual: '(本地执行判分)' }
    default: return { outcome: 'fail', actual: text.slice(0, 40) }
  }
}

export function gradeNumber(text, want) {
  const nums = text.replace(/[,，\s]/g, '').match(/-?\d+(\.\d+)?/g)
  if (!nums?.length) return { outcome: text.trim() ? 'fail' : 'empty', actual: text.slice(0, 40) }
  const target = String(want).replace(/[,，\s]/g, '')
  // 优先取最后一个独立数字(模型常先解释后作答)
  const ok = nums.includes(target)
  return ok ? { outcome: 'pass', actual: target } : { outcome: 'fail', actual: nums.slice(-3).join(',') }
}

function parseProbability(text) {
  const frac = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/)
  if (frac) return Number(frac[1]) / Number(frac[2])
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (pct) return Number(pct[1]) / 100
  const dec = text.match(/(?:约|≈|is |:|=)?\s*(\d*\.\d+)/)
  if (dec) return Number(dec[1])
  return null
}

function tryParseJSON(text) {
  const direct = (() => { try { return JSON.parse(text) } catch { return null } })()
  if (direct) return direct
  const m = text.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch { return null } }
  return null
}

/** 提取并执行模型代码,返回测试明细。子进程 10s 超时。 */
export async function execCodeTests(item, answer) {
  const code = extractCode(String(answer ?? ''))
  const tests = item.tests
  const harness = `${code}\n;(function(){const __tests=${JSON.stringify(tests)};for(const t of __tests){let out;try{const got=eval(t.expr);const ok=typeof got==='number'&&typeof t.expect==='number'?Math.abs(got-t.expect)<1e-9:got===t.expect;out={expr:t.expr,got:String(got),expect:String(t.expect),ok}}catch(e){out={expr:t.expr,error:String(e).slice(0,150),ok:false}}console.log(JSON.stringify(out))}})();`
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const child = spawn('node', ['-e', harness], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
    child.stdout.on('data', (d) => { stdout += d })
    child.on('error', (e) => { if (!settled) { settled = true; resolve({ outcome: 'error', detail: String(e).slice(0, 120) }) } })
    child.on('close', () => {
      if (settled) return
      settled = true
      const lines = stdout.trim().split('\n').filter(Boolean)
      const details = []
      for (const line of lines) {
        try { details.push(JSON.parse(line)) } catch { /* 忽略非 JSON 输出 */ }
      }
      if (!details.length) return resolve({ outcome: 'error', detail: '无测试输出(可能未输出可用代码或执行超时)' })
      const passed = details.filter((d) => d.ok).length
      resolve({
        outcome: passed === tests.length ? 'pass' : passed === 0 ? 'fail' : 'partial',
        actual: `${passed}/${tests.length} tests`,
        detail: details.map((d) => `${d.expr} → ${d.ok ? '✓' : `✗ got ${d.got ?? d.error}`}`).join('; '),
      })
    })
  })
}

export function extractCode(text) {
  const fence = text.match(/```(?:javascript|js|node)?\s*([\s\S]*?)```/)
  let code = fence ? fence[1] : text
  code = code.replace(/^\s*(?:export\s+)?(?:default\s+)?/gm, (m) => m.replace('export ', ''))
  code = code.replace(/module\.exports\s*=[^;\n]*;?/g, '')
  code = code.replace(/export\s+default\s+/g, '')
  code = code.replace(/export\s+\{[^}]*\};?/g, '')
  return code
}
