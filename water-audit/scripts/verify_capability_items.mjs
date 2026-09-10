#!/usr/bin/env node
/**
 * 题库答案本地复核: 对所有可计算题重新推导/暴力计算,与题库答案比对。
 * 任何一项不符 → 退出码 1(题库禁止带病发布)。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const items = JSON.parse(readFileSync(join(HERE, '../src/references/capability-items.json'), 'utf-8')).items

const computed = {
  e1: String(47 * 83 + 291),
  e2: String((18 + 24) * 15 - 70),
  e4: '23', // 2,3,5,8,12,17 差值 1,2,3,4,5 → +6
  e6: String('cucumber'.length),
  m1: String(738 * 462),
  m2: String((94 - 35 * 2) / 2), // 鸡兔同笼
  m3: String([1, 2, 3, 6].filter((x) => x * x - 5 * x + 6 === 0).sort((a, b) => b - a)[0]),
  m4: String(6 / 36),
  m6: String(0.5 * 10 * 3 ** 2),
  h1: '204', // AIME 2024 I-1: s=2.5, t=24 → (9/3)*60+24
  h2: String(Math.max(...range(1, 200).filter((n) => zeros(n) === 6))),
  h3: String(String(123456 * 654321).split('').reduce((s, d) => s + +d, 0)),
  h5: String(Math.max(...range(100, 1000).filter((n) => Number.isInteger(Math.sqrt(n + 210)) && Math.sqrt(n + 210) ** 2 === n + 210))),
  h6: String(fact(6) / 2),
  f1: '4E2D',
  f3: String(nthPrime(25)),
  d1: String('strawberry'.split('').filter((c) => c === 'r').length),
  d2: String('bookkeeper'.split('').filter((c) => c === 'e').length),
  d3: String(4837 * 291),
  d4: String(9000001 + 12345678),
  e5: 'A', m5: 'C', // 事实题复核标注(光速≈3e8 m/s;里海为最大湖泊)
}
// 代码题本地验证测试期望值
const codeChecks = {
  e7: eval(`(function(){function add(a,b){return a+b};return [add(2,3)===5,add(-1,1)===0,Math.abs(add(0.5,0.25)-0.75)<1e-9].every(Boolean)})()`),
  m7: eval(`(function(){function isPalindrome(s){const t=s.toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fff]/g,'');return t===[...t].reverse().join('')};return [isPalindrome('A man, a plan, a canal: Panama')===true,isPalindrome('race a car')===false,isPalindrome('')===true,isPalindrome('上海自来水来自海上')===true].every(Boolean)})()`),
  h4: eval(`(function(){function countPrimes(n){const s=new Array(n).fill(true);let c=0;for(let i=2;i<n;i++){if(s[i]){c++;for(let j=i*i;j<n;j+=i)s[j]=false}}return c};return [countPrimes(10)===4,countPrimes(100)===25,countPrimes(2)===0].every(Boolean)})()`),
}

let fail = 0
for (const it of items) {
  if (it.id in computed) {
    const ok = computed[it.id] === String(it.answer)
    if (!ok) { fail++; console.log(`✗ ${it.id}: 题库答案 ${it.answer} ≠ 复核值 ${computed[it.id]}`) }
    else console.log(`✓ ${it.id} = ${it.answer}`)
  } else if (it.id in codeChecks) {
    if (!codeChecks[it.id]) { fail++; console.log(`✗ ${it.id}: 代码测试期望值未通过本地验证`) }
    else console.log(`✓ ${it.id} 测试期望值已验证`)
  } else {
    console.log(`· ${it.id}(${it.answerType}) 事实/构造题,出处: ${it.source ?? '题面自含'}`)
  }
}
function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r }
function zeros(n) { let c = 0; for (let p = 5; p <= n; p *= 5) c += Math.floor(n / p); return c }
function fact(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r }
function nthPrime(k) { const ps = []; for (let n = 2; ps.length < k; n++) { if (ps.every((p) => n % p)) ps.push(n) } return ps[k - 1] }
if (fail) { console.log(`\n${fail} 项不符,题库需要修正!`); process.exit(1) }
console.log('\n全部可复核答案通过。')
