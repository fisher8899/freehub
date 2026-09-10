#!/usr/bin/env node
/**
 * 本地 mock 端点(自测/演示用,不依赖任何外部服务):
 *
 *   node test/mock-server.mjs --mode honest   --port 8801   # 真装 gpt-4o(o200k + gpt-4o 行为参考 + 全能力)
 *   node test/mock-server.mjs --mode cheater  --port 8802   # 挂羊头卖狗肉:声称 gpt-4o,实为 mini 行为 + cl100k 分词器 + 弱能力
 *   node test/mock-server.mjs --mode cacher   --port 8803   # 网关缓存:同提示永远同答
 *
 * mock 的"知识"来自仓库内置参考数据(behavioral-fingerprints / tokenizer-counts),
 * 因此 water-audit 对它的判定结果可以完全离线复现。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REFS = JSON.parse(readFileSync(join(HERE, '../src/references/behavioral-fingerprints.json'), 'utf-8'))
const TOKREFS = JSON.parse(readFileSync(join(HERE, '../src/references/tokenizer-counts.json'), 'utf-8'))
const CANON = JSON.parse(readFileSync(join(HERE, '../src/references/canonical-strings.json'), 'utf-8'))

const args = process.argv.slice(2)
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const MODE = getArg('mode', 'honest')
const PORT = Number(getArg('port', 8801))

const HONEST_TOK = 'o200k_base'      // 真 gpt-4o 的分词器
const CHEAT_TOK = 'cl100k_base'      // 换皮成了 cl100k 系模型
const TOK = MODE === 'cheater' ? CHEAT_TOK : HONEST_TOK
const OVERHEAD = MODE === 'cheater' ? 9 : 7   // chat 模板 overhead(两者不同,增加真实感)
const BEHAVIOR = MODE === 'cheater' ? 'openai/gpt-4o-mini' : 'openai/gpt-4o'

// ---------- 行为分布采样 ----------
const paraphraseToCell = new Map()
for (const [cellId, cell] of Object.entries(REFS.models[BEHAVIOR].cells)) {
  // 参考数据的 key 即 cellId;同时注册本仓库 battery 的改写文本(导入方式见下)
}
const { PROBE_TASKS } = await import('../src/battery.js')
for (const [task, spec] of Object.entries(PROBE_TASKS)) {
  for (const lang of ['en', 'zh']) {
    for (const p of spec.paraphrases[lang]) paraphraseToCell.set(p, `${task}:${lang}`)
  }
}
function sampleBehavior(cellId) {
  const cell = REFS.models[BEHAVIOR].cells[cellId]
  if (!cell?.counts) return null
  const entries = Object.entries(cell.counts)
  const total = entries.reduce((s, [, n]) => s + n, 0)
  let r = Math.random() * total
  for (const [ans, n] of entries) {
    r -= n
    if (r <= 0) return ans
  }
  return entries[0]?.[0] ?? 'blue'
}

// ---------- 简易问答规则(能力/身份/事件/长上下文) ----------
const QA = [
  // 身份
  { re: /你是什么模型|What model are you|真实身份|Complete this sentence|Which company built you|不担心任何授权/, a: () => '我是 OpenAI 开发的 GPT-4o 大语言模型。' },
  // 知识截止
  { re: /知识截止|knowledge cutoff|最近了解到的重大事件|2024 年 12 月发生的事/, a: () => '我的知识截止时间是 2023 年 10 月。' },
  // 事件时间线
  { re: /卡塔尔世界杯/, a: () => '阿根廷' },
  { re: /OpenAI 在 2023 年 11 月/, a: () => 'Sam Altman(奥特曼)' },
  { re: /2024 年夏季奥运会/, a: () => '巴黎' },
  { re: /2024 年美国总统大选/, a: () => '特朗普' },
  { re: /极低训练成本/, a: () => (MODE === 'cheater' ? 'ChatGPT' : 'DeepSeek-R1') },
  { re: /奥斯卡最佳影片/, a: () => (MODE === 'cheater' ? '《奥本海默》' : '《阿诺拉》(Anora)') },
  // 稳定性
  { re: /12345×6789|12345\s*\*\s*6789/, a: () => '83810205' },
  { re: /随机生成一个 8 位数字码/, a: () => (MODE === 'cacher' ? '31415926' : String(Math.floor(Math.random() * 1e8)).padStart(8, '0')) },
  { re: /^Say "pong"\.$/, a: () => 'pong' },
  { re: /从 1 数到 30/, a: () => '1、2、3、4、5、6、7、8、9、10、11、12、13、14、15、16、17、18、19、20、21、22、23、24、25、26、27、28、29、30' },
  { re: /守株待兔/, a: () => '比喻不主动努力而存侥幸心理,妄想靠运气得到意外收获。' },
  { re: /capital of Australia/i, a: () => 'The capital of Australia is Canberra.' },
  // 长上下文暗号
  { re: /机要暗号为「(ZW-\d{5})」/, a: (m) => m[1], regexCapture: true },
  // 能力题
  { re: /47×83\+291|47 \* 83 \+ 291/, a: () => '4192' },
  { re: /\(18\+24\)×15−70|\(18 \+ 24\) × 15 - 70/, a: () => '560' },
  { re: /三儿子叫什么/, a: () => '小明' },
  { re: /2, 3, 5, 8, 12, 17/, a: () => '23' },
  { re: /光在真空中的速度/, a: () => 'A' },
  { re: /cucumber 一共有几个字母/, a: () => '8' },
  { re: /高大.*的反义词/, a: () => '矮小' },
  { re: /738×462|738 \* 462/, a: () => (MODE === 'cheater' ? '340958' : '340956') },
  { re: /鸡兔同笼/, a: () => '12' },
  { re: /较大的根/, a: () => '3' },
  { re: /点数之和恰好为 7 的概率/, a: () => '1/6' },
  { re: /面积最大的湖泊/, a: () => 'C' },
  { re: /下落 3 秒的下落距离/, a: () => '45' },
  { re: /JSON 对象.*"color"/s, a: () => '{"color": "blue"}' },
  { re: /Aya.*散步|s\+1\/2 千米\/小时/, a: () => (MODE === 'cheater' ? '264' : '204') },
  { re: /末尾恰好有 6 个连续的 0/, a: () => (MODE === 'cheater' ? '30' : '29') },
  { re: /123456×654321|123456 \* 654321/, a: () => (MODE === 'cheater' ? '59' : '63') },
  { re: /countPrimes\(n\)/, a: () => MODE === 'cheater'
    ? 'function countPrimes(n){let c=0;for(let i=2;i<n;i++){if(i%2===0&&i!==2)continue;c++}return c+1}'
    : 'function countPrimes(n){const sieve=new Array(n).fill(true);let c=0;for(let i=2;i<n;i++){if(sieve[i]){c++;for(let j=i*i;j<n;j+=i)sieve[j]=false}}return c}' },
  { re: /最大的三位数 n,使得 n\+210/, a: () => (MODE === 'cheater' ? '900' : '946') },
  { re: /甲必须站在乙的左边/, a: () => (MODE === 'cheater' ? '720' : '360') },
  { re: /『中』的 Unicode 码点/, a: () => 'U+4E2D' },
  { re: /威尔士语.*两字母语言代码/, a: () => (MODE === 'cheater' ? 'zh' : 'cy') },
  { re: /第 25 个质数/, a: () => '97' },
  { re: /5 个 'a' 后跟 5 个 'b'/, a: () => 'aaaaabbbbb' },
  { re: /七千二百八十三/, a: () => '好的,我记住了。你最喜欢的数字是:\n7283' },
  { re: /呈液态的金属单质/, a: () => 'Br' },
  { re: /strawberry 中字母 r/, a: () => (MODE === 'cheater' ? '2' : '3') },
  { re: /bookkeeper 中字母 e/, a: () => '3' },
  { re: /4837×291|4837 \* 291/, a: () => (MODE === 'cheater' ? '1407569' : '1407567') },
  { re: /9000001\+12345678/, a: () => '21345679' },
  // 代码题
  { re: /函数 add\(a, b\)/, a: () => 'function add(a, b) {\n  return a + b;\n}' },
  { re: /isPalindrome\(s\)/, a: () => "function isPalindrome(s) {\n  const t = s.toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fff]/g, '');\n  return t === [...t].reverse().join('');\n}" },
]

function answerFor(userText) {
  // 1) 行为指纹探针(按改写文本匹配 cell)
  const cellId = paraphraseToCell.get(userText.trim())
  if (cellId) {
    const sampled = sampleBehavior(cellId)
    if (sampled != null) return sampled
  }
  // 2) 分词器探针(规范字符串精确匹配)
  const idx = CANON.strings.indexOf(userText)
  if (idx >= 0) {
    return '1' // max_tokens=1;计数看 usage
  }
  // 3) 规则问答
  for (const q of QA) {
    const m = userText.match(q.re)
    if (m) return q.regexCapture ? q.a(m) : q.a()
  }
  return '这是一个很好的问题。作为 GPT-4o,我会尽力帮助你。'
}

function countTokens(text) {
  const idx = CANON.strings.indexOf(text)
  if (idx >= 0 && TOKREFS.tokenizers[TOK]) return TOKREFS.tokenizers[TOK].counts[idx] + OVERHEAD
  return Math.max(1, Math.round(text.length / 3.6)) + OVERHEAD // 非规范文本粗估
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const chunks = []
  for await (const c of req) chunks.push(c)
  const bodyRaw = Buffer.concat(chunks).toString('utf-8')
  let body = {}
  try { body = JSON.parse(bodyRaw || '{}') } catch { /* ignore */ }

  if (url.pathname.endsWith('/models')) {
    return json(res, 200, { object: 'list', data: [{ id: body?.model ?? 'gpt-4o', object: 'model' }, { id: 'gpt-4o-mini', object: 'model' }] })
  }

  if (body.model !== 'gpt-4o') {
    if (MODE === 'cheater') {
      return json(res, 503, { error: { message: '当前分组 default 下对于模型 gpt-4o 无可用渠道', type: 'one_api_error' } }, { 'x-oneapi-request-id': 'mock-relay-1' })
    }
    return json(res, 404, { error: { message: `The model \`${body.model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', param: null, code: 'model_not_found' } })
  }

  const userText = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content
    ?? (body.messages ?? []).map((m) => typeof m.content === 'string' ? m.content : '').join('\n')
  const answer = answerFor(userText)
  const promptTokens = countTokens(userText)
  const completionTokens = Math.max(1, Math.round(answer.length / 3.8))
  const id = `chatcmpl-mock${Math.random().toString(36).slice(2, 10)}`
  const created = Math.floor(Date.now() / 1000)

  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const first = { id, object: 'chat.completion.chunk', created, model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }
    res.write(`data: ${JSON.stringify(first)}\n\n`)
    const piece = Math.max(1, Math.ceil(answer.length / 6))
    for (let i = 0; i < answer.length; i += piece) {
      const c = { id, object: 'chat.completion.chunk', created, model: 'gpt-4o', choices: [{ index: 0, delta: { content: answer.slice(i, i + piece) }, finish_reason: null }] }
      res.write(`data: ${JSON.stringify(c)}\n\n`)
      await sleep(8)
    }
    const last = { id, object: 'chat.completion.chunk', created, model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }
    res.write(`data: ${JSON.stringify(last)}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  return json(res, 200, {
    id,
    object: 'chat.completion',
    created,
    model: 'gpt-4o',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: answer },
      finish_reason: 'stop',
      ...(body.logprobs ? { logprobs: { content: answer.split(/\s+/).slice(0, 8).map((t) => ({ token: t, logprob: -0.4 - Math.random() * 2 })) } } : {}),
    }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    system_fingerprint: 'fp_mock_20260910',
  })
})

function json(res, status, obj, headers = {}) {
  const text = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(text)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-server [${MODE}] listening on http://127.0.0.1:${PORT}/v1 (tokenizer=${TOK}, behavior=${BEHAVIOR})`)
})
