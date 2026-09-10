# water-audit · 模型注水检测器

> 你买/白嫖的 API 说自己跑的是 `gpt-4o` / `deepseek-v3` / `claude-sonnet-4.5`,它真的在跑吗?
> **water-audit** 对任意 OpenAI 兼容端点做 7 个维度的取证式审计,输出证据化报告,
> 每一个判定都有数据、公式与出处;查不到证据的,如实写「无法确认」。

```bash
node bin/water-audit.js --base-url https://api.example.com/v1 \
     --api-key sk-xxx --model gpt-4o --budget standard
```

零 npm 依赖(Node ≥ 18.17),报告输出到 `reports/<时间>-<模型>/`:
`report.html`(自包含,可直接发人)/ `report.md` / `evidence.jsonl`(全部原始交互)/ `summary.json`。

---

## 一、它能检测哪些"注水"形态

| 注水手法 | 对应检测 |
| --- | --- |
| 偷偷换成小杯(4o → 4o-mini / opus → sonnet) | 单 token 行为指纹、能力分层 |
| 换成别家模型(声称 GPT 实为开源模型) | 行为指纹 + **分词器指纹** + 身份自报 |
| 量化/蒸馏劣化(模型对但被削) | 长尾与精确执行层、字母计数/大数算术劣化信号、logprobs 困惑度档案 |
| 砍上下文(号称 128K 实给 8K) | 合成暗号长上下文探针 + usage 截断证据 |
| 网关缓存/录像重放(假装在推理) | 温度 1 随机码重放检测、split-half 自检 |
| 多后端轮换(同一个 key 抽卡) | split-half 自检、行为最近邻离散度 |
| 系统提示词伪装身份 | 6 种问法交叉自报 + 管道形态交叉验证(诚实标注:可被伪装) |

## 二、七个探针维度

| # | 维度 | 方法 | 证据强度 |
| --- | --- | --- | --- |
| 1 | **基础设施指纹** | `/models`、响应/错误体/SSE 结构、参数支持矩阵、延迟画像 → 识别接栈(官方 / one-api 系中转 / vLLM 自建) | 旁证 |
| 2 | **分词器指纹** | 36 条冻结规范字符串的 `usage.prompt_tokens` 做**锚点相对差值匹配**,精确区分 o200k / cl100k / Llama-3 等词表;与声称模型应有分词器对表 | **硬证据**(usage 造假的除外) |
| 3 | **身份与知识截止** | 6 种问法自报 + 4 种问法自报截止 + 6 个带日期既定事件时间线 | 线索(中) |
| 4 | **单 token 行为指纹** | 论文协议(arXiv:2607.10252):随机数/颜色/动物等 8 任务 × 2 语言,采回答分布,与参考指纹算平均 JSD | **硬证据**(同协议参考) |
| 5 | **能力分层评测** | 32 道全程序化判分题(E 基础/M 中等/H 竞赛/F 长尾/D 劣化信号),Wilson 95% CI 对公开分数带 | **硬证据**(远低于公开带时) |
| 6 | **长上下文一致性** | 种子随机合成人物志 + 唯一暗号,按预算测 16k/64k/160k/400k 字符深度 | 硬证据(检出截断时) |
| 7 | **稳定性与缓存** | 温度 0 确定性 ×5、随机码重放 ×3、logprobs 困惑度档案 | 混合 |

## 三、方法原理与出处

### 1. 单 token 行为指纹(核心)
Bruckner《One Token Is Enough》(arXiv:2607.10252):让模型做"说一个 1–100 的随机数"这类
无标准答案的单 token 任务,其**回答分布是稳定的模型指纹**(GPT 系偏爱 42/73,不同家族偏爱
不同的数)。同一模型同协议采两次的平均 JSD≈0.140,跨服务商≈0.227,不同模型≈0.463。
判定阈值:**≤0.25 一致 / 0.25–0.35 存疑 / >0.35 不符**。
内置参考:11 个主流模型(gpt-4o、gpt-4o-mini、gpt-4.1-mini、claude-sonnet-4.5、
gemini-2.5-flash、deepseek-chat、kimi-k2、glm-4.5、qwen3-30b、llama-3.1-8b、mistral-small-3.2),
CC-BY-4.0,重构自论文公开数据集(Zenodo DOI 10.5281/zenodo.21278557),采集于 2026-07-08。

### 2. 分词器指纹(独立第二证据)
不同模型家族用不同分词器。把 36 条冻结字符串逐条单独发给端点,读 `usage.prompt_tokens`;
由于 chat 模板造成未知常数偏移,匹配采用**锚点相对差值法**(每条与首条的计数差),差值与
模板无关,可精确区分词表。参考表由 tiktoken 官方正则+官方词表(OpenAI 四代)与 Meta 官方
词表(Llama-3/4, PyPI `llama-models`)本地精确计算,脚本可复现:
`scripts/gen_tokenizer_refs.py`。
> 局限(如实):qwen/deepseek/glm/gemma 词表未收录(生成环境访问不到官方词表),
> 声称这些模型时本维度只报告"最像哪个已收录分词器",不发硬判定;
> 服务商若伪造 usage 数字可绕过本维度,此时靠行为指纹与能力层交叉。

### 3. 能力分层(对照公开分数带,而非主观打分)
32 道题全部程序化判分(数字提取/选项/JSON/代码子进程执行),答案均可本地复核:
`node scripts/verify_capability_items.mjs`。命中率先算 **Wilson 95% 置信区间**,再与
`src/references/models.json` 里**注明官方出处与截至日期**的公开分数带比较:
- 实测 CI 下限 ≥ 带下限 → 达标;
- 点估计达标但 CI 未达 → 边缘;
- 远低于带下限 → 强烈提示不符(硬证据)。
声称模型无可靠公开数据时(如部分新模型),**只记录实测,不做绝对判定** —— 宁可留空,绝不编数。

### 4. 其余
长上下文用种子随机合成文本,暗号不可预测,判分零主观;缓存检测利用"温度 1 随机码 3 次全同
概率≈0";split-half 自检把本次样本对半自比,距离高 = 端点自身不稳定(多后端轮换的典型症状)。

## 四、判定规则(完全透明)

```
任一硬证据成立            → ❌ 证据表明不符
  硬证据 = 行为指纹 mismatch(同协议参考)
        ∨ 分词器与声称模型已知词表不符
        ∨ ≥2 个能力层远低于公开分数带
        ∨ 温度 0 确定性算术全错
存在可疑信号              → ⚠️ 可疑
各维度均一致              → ✅ 未发现注水证据
过半维度无有效数据         → ❔ 无法判定
```

**「未发现注水证据」≠ 证明没注水。** 每个维度独立给判定与置信度;
评分只在有明确公式时给出(如分词器匹配率 = 匹配差值数/可比差值数),公式印在报告里;
所有结论引用 `evidence.jsonl` 的证据编号(E-xxxx),可逐条回查原始请求与响应。

## 五、最可靠的用法:enroll 同协议比对(金标准)

内置参考存在渠道/时间漂移,是"指示性"比对。**同协议自采参考**才是最硬的:
有任一官方渠道 key(哪怕额度很小)时:

```bash
# 1. 用官方 key 采参考(约 200 次一 token 请求,几分钱)
node bin/water-audit.js --base-url https://api.openai.com/v1 \
     --api-key sk-官方 --model gpt-4o --enroll ref-gpt4o.json

# 2. 审计可疑端点(同协议严格比对)
node bin/water-audit.js --base-url https://可疑中转/v1 \
     --api-key sk-中转 --model gpt-4o --ref ref-gpt4o.json --budget deep
```

没有官方 key 时,工具自动回退到内置论文参考(指示性)+ 分词器/能力层硬证据,并在报告的
「无法确认的事项」里如实写明哪些环节降级了。

## 六、预算档位

| 档位 | 行为指纹 | 长上下文 | 适用 |
| --- | --- | --- | --- |
| `quick` | 4 格 × 15 | 16k 字符 | 快速体检(~150 请求) |
| `standard`(默认) | 8 格 × 25 | 16k+64k | 日常审计(~350 请求) |
| `deep` | 16 格 × 25 | 16k→400k | 出报告/实锤取证(~900 请求) |

`--no-exec` 可禁止在本地执行模型生成的代码(代码题跳过)。所有请求仅发往 `--base-url`,
不经过任何第三方。

## 七、自测与扩展

```bash
npm run mock            # 起本地假端点(honest/cheater/cacher 三种模式)
npm run selftest        # 端到端自测: 假"真 4o"应判无证据;假"挂羊头卖狗肉"应判不符
node scripts/verify_capability_items.mjs   # 复核题库全部可计算答案
python scripts/gen_tokenizer_refs.py --npm-dir <gpt-tokenizer解压目录>  # 重建分词器参考表
```

**补全国产模型分词器参考**(qwen/deepseek/glm/gemma,基础环境访问不到官方词表,建议在本地做):

```bash
pip install tokenizers
python scripts/gen_tokenizer_refs_extra.py --preset qwen2.5      # 或 qwen3 / deepseek-v3 / glm-4 / gemma-2
python scripts/gen_tokenizer_refs_extra.py --preset qwen2.5 --hf-endpoint https://hf-mirror.com  # 镜像
python scripts/gen_tokenizer_refs_extra.py --local tokenizer.json --name qwen2.5 --family qwen   # 离线(浏览器下载好文件)
```

生成的参考合并进 `src/references/tokenizer-counts.json`,water-audit 下次运行自动使用;
声称模型不在已收录词表里时,分词器维度只做"最像哪个"的报告,不发硬判定。

`test/selftest.mjs` 会自动起两个 mock:一个"真装 gpt-4o"(o200k 词表 + gpt-4o 行为参考),
一个"声称 gpt-4o 实为 mini"(cl100k 词表 + mini 行为 + 弱能力),断言审计方向正确。
`test/mock-server.mjs --mode cacher` 模拟网关缓存重放,验证缓存检测。

## 八、诚实声明(必读)

1. **行为/分词器/能力指纹都是统计证据,不是法律证明。** 阈值带内存在合法漂移:模型版本更新、
   服务商改系统提示词、量化部署都可能移动分布。结论请用于"是否继续用/换渠道/找服务商对质"的决策,而非公开指控。
2. **可被主动欺骗的点**:身份自报(系统提示词可伪装)、`usage` 数字(可伪造)、知识截止(RAG 可注水)。
   本工具对这些维度一律标注"低/中"置信度,不单独作为硬证据。
3. **题库规模小**(32 题),能力层只做粗粒度分层判定,置信区间已印在报告中。
4. **参考会过时**:内置行为参考采集于 2026-07;模型更新后请自采参考(enroll)。
5. 未经确认的事项,报告单列一节如实列出;**没有数据支持的结论一律不写**。

## 九、参考数据许可与出处

| 文件 | 内容 | 许可 | 出处 |
| --- | --- | --- | --- |
| `behavioral-fingerprints.json` | 11 模型单 token 回答分布 | CC-BY-4.0 | arXiv:2607.10252 / Zenodo 10.5281/zenodo.21278557,经 llm-fingerprint-detector 重构 |
| `tokenizer-counts.json` | 36 字符串 × 6 词表的精确计数 | 事实数据 | tiktoken 官方正则+词表;Meta 官方 llama-models |
| `capability-items.json` | 32 道可复核题 | MIT | 全部本地可复核(h1 为 AIME 2024 I 公开真题) |
| `models.json` | 官方上下文/截止/公开分数带 | 事实数据 | 逐条注明出处与截至日期 |

---
water-audit v0.1.0 · MIT License · FreeHub 子项目
