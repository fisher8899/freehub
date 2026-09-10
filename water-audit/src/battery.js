/**
 * 单 token 行为指纹探针库(one-token/v1 协议)。
 * 忠实移植 arXiv:2607.10252 及 llm-fingerprint-detector 的任务/改写/排序,
 * 保证与内置参考数据(behavioral-fingerprints.json)同协议可比。
 */

export const SYSTEM_PROMPTS = {
  en: 'Answer with exactly one word. No punctuation, no explanation.',
  zh: '只回答一个词，不要标点，不要解释。',
}

export const PROBE_TASKS = {
  'random-number-1-100': {
    domain: { kind: 'int', min: 1, max: 100 },
    paraphrases: {
      en: [
        'Name a random number between 1 and 100.',
        'Pick a random number from 1 to 100.',
        'Give me a random number between 1 and 100.',
        'Choose any number between 1 and 100 at random.',
      ],
      zh: [
        '说一个 1 到 100 之间的随机数。',
        '随机挑一个 1 到 100 的数字。',
        '给我一个 1 至 100 之间的随机数字。',
        '从 1 到 100 里随便选一个数。',
      ],
    },
  },
  'random-number-1-10': {
    domain: { kind: 'int', min: 1, max: 10 },
    paraphrases: {
      en: ['Name a random number between 1 and 10.', 'Pick a random number from 1 to 10.', 'Give me a random number between 1 and 10.'],
      zh: ['说一个 1 到 10 之间的随机数。', '随机挑一个 1 到 10 的数字。', '从 1 到 10 里随便选一个数。'],
    },
  },
  'random-letter': {
    domain: { kind: 'letter' },
    paraphrases: {
      en: ['Name a random letter of the alphabet.', 'Pick a random letter from A to Z.', 'Give me one random letter.'],
      zh: ['说一个随机的英文字母。', '从 A 到 Z 里随便挑一个字母。', '随机给我一个英文字母。'],
    },
  },
  'random-color': {
    domain: { kind: 'color' },
    paraphrases: {
      en: ['Name a random color.', 'Pick a color at random.', 'Give me one random color.'],
      zh: ['说一个随机的颜色。', '随便说一种颜色。', '随机挑一个颜色告诉我。'],
    },
  },
  'coin-flip': {
    domain: { kind: 'coin' },
    paraphrases: {
      en: ['Flip a coin. Answer heads or tails.', 'Toss a coin and tell me the result: heads or tails.', 'Imagine flipping a coin. Which side came up, heads or tails?'],
      zh: ['抛一枚硬币，回答正面还是反面。', '掷一次硬币，告诉我结果：正面或反面。', '想象抛硬币，落地是正面还是反面？'],
    },
  },
  'random-animal': {
    domain: { kind: 'word' },
    paraphrases: {
      en: ['Name a random animal.', 'Pick an animal at random.', 'Give me one random animal.'],
      zh: ['说一个随机的动物。', '随便说一种动物。', '随机挑一个动物告诉我。'],
    },
  },
  'random-city': {
    domain: { kind: 'word' },
    paraphrases: {
      en: ['Name a random city.', 'Pick a city at random.', 'Give me the name of one random city.'],
      zh: ['说一个随机的城市。', '随便说一座城市。', '随机挑一个城市告诉我。'],
    },
  },
  'favorite-number': {
    domain: { kind: 'int', min: 0, max: 10_000 },
    paraphrases: {
      en: ['What is your favorite number?', 'Tell me your favourite number.', 'If you had to pick a favorite number, what would it be?'],
      zh: ['你最喜欢的数字是什么？', '说说你最爱的数字。', '如果必须选一个最喜欢的数字，你选哪个？'],
    },
  },
}

/** 全部 16 格,按区分度排序(论文与跨模型实测:随机数任务区分度最高)。 */
export const CELL_PRIORITY_ORDER = [
  'random-number-1-100:en',
  'random-number-1-100:zh',
  'random-color:en',
  'random-animal:en',
  'random-number-1-10:en',
  'random-letter:en',
  'random-color:zh',
  'coin-flip:en',
  'favorite-number:en',
  'random-city:en',
  'random-number-1-10:zh',
  'coin-flip:zh',
  'random-letter:zh',
  'random-animal:zh',
  'random-city:zh',
  'favorite-number:zh',
]

export const PRESETS = {
  quick: { cellCount: 4, samplesPerCell: 15 },
  standard: { cellCount: 8, samplesPerCell: 25 },
  strict: { cellCount: 16, samplesPerCell: 25 },
}

export const PROBE_TEMPERATURE = 1.0
export const PROBE_MAX_TOKENS = 16
export const POST_REASONING_MAX_TOKENS = 1024

export function cellsForPreset(presetId) {
  const p = PRESETS[presetId] ?? PRESETS.standard
  return CELL_PRIORITY_ORDER.slice(0, p.cellCount)
}

export function samplesPerCellFor(presetId) {
  return (PRESETS[presetId] ?? PRESETS.standard).samplesPerCell
}

export function parseCellId(cellId) {
  const idx = cellId.lastIndexOf(':')
  return { task: cellId.slice(0, idx), lang: cellId.slice(idx + 1) }
}

export function getSystemPrompt(cellId) {
  return SYSTEM_PROMPTS[parseCellId(cellId).lang]
}

export function getDomain(cellId) {
  return PROBE_TASKS[parseCellId(cellId).task].domain
}

export function pickParaphrase(cellId, random = Math.random) {
  const { task, lang } = parseCellId(cellId)
  const pool = PROBE_TASKS[task].paraphrases[lang]
  return pool[Math.floor(random() * pool.length)] ?? pool[0]
}

/**
 * 推理模式关闭适配层:隐藏思考必须关掉,否则会烧掉 max_tokens 并移动分布。
 * 三种已知请求体变体,探测顺序按 base-url 提示;全部失败则退回裸请求;
 * 仍无可见证文本时降级为 post-reasoning 通道(max_tokens=1024,低置信标记)。
 */
export const REASONING_STRATEGY_BODIES = {
  'openrouter-reasoning': { reasoning: { enabled: false } },
  'zhipu-thinking': { thinking: { type: 'disabled' } },
  'openai-effort': { reasoning_effort: 'none' },
}

export function adapterHintOrder(baseUrl) {
  const u = baseUrl.toLowerCase()
  if (u.includes('openrouter')) return ['openrouter-reasoning', 'openai-effort', 'zhipu-thinking']
  if (u.includes('bigmodel') || u.includes('zhipu')) return ['zhipu-thinking', 'openrouter-reasoning', 'openai-effort']
  if (u.includes('openai.com') || u.includes('azure')) return ['openai-effort', 'openrouter-reasoning', 'zhipu-thinking']
  return ['openai-effort', 'openrouter-reasoning', 'zhipu-thinking']
}
