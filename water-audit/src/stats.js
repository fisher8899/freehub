/**
 * 统计工具:熵、Jensen-Shannon 散度(base-2)、Wilson 置信区间、自助法置信区间。
 * 阈值依据见 README「方法与出处」。
 */

export function shannonEntropyBits(counts) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  if (total <= 0) return 0
  let h = 0
  for (const n of Object.values(counts)) {
    if (n <= 0) continue
    const p = n / total
    h -= p * Math.log2(p)
  }
  return h
}

/** JSD(P,Q), base-2, ∈[0,1]。P/Q 为计数表。任一侧无样本返回 null。 */
export function jsdBits(countsP, countsQ) {
  const totalP = Object.values(countsP).reduce((s, n) => s + n, 0)
  const totalQ = Object.values(countsQ).reduce((s, n) => s + n, 0)
  if (totalP <= 0 || totalQ <= 0) return null
  const support = new Set([...Object.keys(countsP), ...Object.keys(countsQ)])
  let hM = 0, hP = 0, hQ = 0
  for (const k of support) {
    const p = (countsP[k] ?? 0) / totalP
    const q = (countsQ[k] ?? 0) / totalQ
    const m = (p + q) / 2
    if (p > 0) hP -= p * Math.log2(p)
    if (q > 0) hQ -= q * Math.log2(q)
    hM -= m * Math.log2(m)
  }
  return hM - (hP + hQ) / 2
}

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null }

export function stdev(xs) {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

export function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function percentile(xs, p) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  return s[idx]
}

/**
 * Wilson 比例置信区间(95%)。比正态近似在小样本/极端比例下稳健。
 * 返回 [lo, hi]。
 */
export function wilsonCI(k, n, z = 1.959964) {
  if (n === 0) return [0, 1]
  const p = k / n
  const denom = 1 + z * z / n
  const centre = p + z * z / (2 * n)
  const spread = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
  return [Math.max(0, (centre - spread) / denom), Math.min(1, (centre + spread) / denom)]
}

/** 自助法(bootstrap)均值 95% 置信区间。 */
export function bootstrapCI(xs, iterations = 2000, seed = 42) {
  if (!xs.length) return [null, null]
  if (xs.length === 1) return [xs[0], xs[0]]
  let s = seed >>> 0
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const means = []
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < xs.length; j++) sum += xs[(rand() * xs.length) | 0]
    means.push(sum / xs.length)
  }
  means.sort((a, b) => a - b)
  return [means[(iterations * 0.025) | 0], means[(iterations * 0.975) | 0]]
}

/** 论文基线与判定阈值(One Token Is Enough, arXiv:2607.10252)。 */
export const JSD_BASELINES = {
  self: 0.14,            // 同模型自比(中位)
  crossProvider: 0.227,  // 同模型跨服务商(中位)
  differentModel: 0.463, // 不同模型(中位)
}
export const JSD_THRESHOLDS = { match: 0.25, mismatch: 0.35 }
export const MIN_VALID_PER_CELL = 10
export const MIN_COMPARABLE_CELLS = 4
export const SPLIT_HALF_WARN = 0.25
