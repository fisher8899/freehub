/**
 * 单 token 回答归一化管线(忠实移植 llm-fingerprint-detector / 论文协议):
 *   NFC → trim → 拒答检测 → 去标点/引号/emoji → 小写 → 取首词
 *     → 数字统一(中文数字/英文数字词/全角/阿拉伯-印度数字 → 拉丁数字)
 *     → 颜色归一(grey→gray, 蓝色→蓝) → 抛硬币归一(正/heads)。
 * 分类: valid(落在域内) / invalid / refusal / empty。
 */

const REFUSAL_PATTERNS = [
  /\bas an ai\b/i,
  /\bi (?:cannot|can't|can not|won't|will not)\b/i,
  /\bi'?m (?:unable|not able|sorry)\b/i,
  /\bsorry,? (?:i|but)\b/i,
  /我不能/,
  /我无法/,
  /无法回答/,
  /不能回答/,
  /抱歉/,
  /对不起/,
  /作为(?:一个)?(?:AI|人工智能)/i,
]

function stripPunctuation(v) {
  return v.replace(/[^\p{L}\p{N}\s]/gu, '')
}

function normalizeDigitScript(v) {
  return v.replace(/[\uFF10-\uFF19\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const c = ch.charCodeAt(0)
    if (c >= 0xff10 && c <= 0xff19) return String(c - 0xff10)
    if (c >= 0x0660 && c <= 0x0669) return String(c - 0x0660)
    return String(c - 0x06f0)
  })
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 }

export function parseChineseNumeral(value) {
  if (!value || !/^[零〇一二两三四五六七八九十百千]+$/.test(value)) return null
  let total = 0, current = 0
  for (const ch of value) {
    if (ch in CN_DIGITS) current = CN_DIGITS[ch]
    else {
      const unit = CN_UNITS[ch]
      total += (current === 0 ? 1 : current) * unit
      current = 0
    }
  }
  return total + current
}

const EN_ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const EN_TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

export function parseEnglishNumberWord(value) {
  const w = value.toLowerCase()
  if (w in EN_ONES) return EN_ONES[w]
  if (w in EN_TENS) return EN_TENS[w]
  if (w === 'hundred' || w === 'onehundred') return 100
  for (const [tens, tv] of Object.entries(EN_TENS)) {
    if (w.startsWith(tens)) {
      const rest = w.slice(tens.length)
      if (rest in EN_ONES && EN_ONES[rest] >= 1 && EN_ONES[rest] <= 9) return tv + EN_ONES[rest]
    }
  }
  return null
}

export function parseAnyNumber(value) {
  if (/^\d+$/.test(value)) return Number(value)
  const cn = parseChineseNumeral(value)
  if (cn !== null) return cn
  return parseEnglishNumberWord(value)
}

const EN_LETTER_NAMES = {
  bee: 'b', cee: 'c', dee: 'd', gee: 'g', jay: 'j', kay: 'k',
  el: 'l', ell: 'l', em: 'm', en: 'n', oh: 'o', pee: 'p',
  cue: 'q', queue: 'q', ar: 'r', es: 's', ess: 's', tee: 't',
  vee: 'v', ex: 'x', why: 'y', zee: 'z', zed: 'z',
}

const EN_COLOR_ALIASES = { grey: 'gray', aqua: 'cyan' }

function normalizeColorWord(word) {
  if (EN_COLOR_ALIASES[word]) return EN_COLOR_ALIASES[word]
  if (/^[\u4e00-\u9fff]{2,}$/.test(word) && word.endsWith('色')) return word.slice(0, -1)
  return word
}

const COIN_HEADS = new Set(['heads', 'head', '正', '正面', '字'])
const COIN_TAILS = new Set(['tails', 'tail', '反', '反面', '花'])

function normalizeCoinWord(word) {
  if (COIN_HEADS.has(word)) return 'heads'
  if (COIN_TAILS.has(word)) return 'tails'
  if (/^正面?/.test(word)) return 'heads'
  if (/^反面?/.test(word)) return 'tails'
  return null
}

/**
 * @param {string} raw 模型原始回答
 * @param {{kind:'int',min:number,max:number}|{kind:'letter'}|{kind:'color'}|{kind:'coin'}|{kind:'word'}} domain
 * @returns {{normalized:string|null, category:'valid'|'invalid'|'refusal'|'empty'}}
 */
export function normalizeAnswer(raw, domain) {
  const nfc = (raw ?? '').normalize('NFC').trim()
  if (!nfc) return { normalized: null, category: 'empty' }
  if (REFUSAL_PATTERNS.some((p) => p.test(nfc))) return { normalized: null, category: 'refusal' }

  const cleaned = normalizeDigitScript(stripPunctuation(nfc)).toLowerCase().trim()
  if (!cleaned) return { normalized: null, category: 'empty' }
  const firstWord = cleaned.split(/\s+/)[0]
  if (!firstWord) return { normalized: null, category: 'empty' }

  switch (domain.kind) {
    case 'int': {
      const num = parseAnyNumber(firstWord)
      if (num === null) return { normalized: firstWord, category: 'invalid' }
      if (num < domain.min || num > domain.max) return { normalized: String(num), category: 'invalid' }
      return { normalized: String(num), category: 'valid' }
    }
    case 'letter': {
      const mapped = EN_LETTER_NAMES[firstWord] ?? firstWord
      if (/^[a-z]$/.test(mapped)) return { normalized: mapped, category: 'valid' }
      return { normalized: firstWord, category: 'invalid' }
    }
    case 'color': {
      const color = normalizeColorWord(firstWord)
      if (/^(?:[a-z]+|[\u4e00-\u9fff]{1,4})$/.test(color)) return { normalized: color, category: 'valid' }
      return { normalized: firstWord, category: 'invalid' }
    }
    case 'coin': {
      const coin = normalizeCoinWord(firstWord)
      if (coin) return { normalized: coin, category: 'valid' }
      return { normalized: firstWord, category: 'invalid' }
    }
    case 'word': {
      if (/^(?:[a-z]+|[\u4e00-\u9fff]{1,6})$/.test(firstWord)) return { normalized: firstWord, category: 'valid' }
      return { normalized: firstWord, category: 'invalid' }
    }
    default:
      return { normalized: firstWord, category: 'invalid' }
  }
}
