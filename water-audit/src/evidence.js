/**
 * 证据记录器:每一次 API 交互、每一条判分、每一个判定都落到证据表,
 * 报告中的每个结论都引用证据编号,保证「评价打分有据可查」。
 */
export class Evidence {
  constructor() { this.records = [] }

  /** @returns {string} 证据编号 E-0001 */
  add(type, data) {
    const id = `E-${String(this.records.length + 1).padStart(4, '0')}`
    this.records.push({ id, ts: new Date().toISOString(), type, ...data })
    return id
  }

  toJSONL() {
    return this.records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  }
}

/** 统一的结果结构 */
export function result({ id, title, status, confidence = null, score = null, scoreFormula = null, summary, metrics = {}, findings = [], evidenceIds = [], raw = null }) {
  return { id, title, status, confidence, score, scoreFormula, summary, metrics, findings, evidenceIds, raw }
}

/**
 * status ∈
 *  consistent   —— 与「声称模型」一致,未发现注水证据
 *  suspicious   —— 出现可疑信号,不能定论
 *  mismatch     —— 有证据表明与声称不符
 *  inconclusive —— 证据不足,无法判定(如实说明)
 *  na           —— 该项不适用(如端点不支持所需参数)
 */
export const STATUS = { CONSISTENT: 'consistent', SUSPICIOUS: 'suspicious', MISMATCH: 'mismatch', INCONCLUSIVE: 'inconclusive', NA: 'na' }
