#!/usr/bin/env python3
"""
补充分词器参考表(国产/其他开源模型词表,需要 HuggingFace 或镜像可达,或本地已有 tokenizer.json)。

为 canonical-strings.json 的 36 条规范字符串计算指定分词器的精确 token 数,
合并进 src/references/tokenizer-counts.json(已有条目不覆盖,同名则替换并注明更新)。

前置: pip install tokenizers

用法示例:
  # 内置预设(推荐,写明了各词表覆盖的模型系列):
  python scripts/gen_tokenizer_refs_extra.py --preset qwen2.5
  python scripts/gen_tokenizer_refs_extra.py --preset qwen3
  python scripts/gen_tokenizer_refs_extra.py --preset deepseek-v3
  python scripts/gen_tokenizer_refs_extra.py --preset glm-4
  python scripts/gen_tokenizer_refs_extra.py --preset gemma-2

  # 指定任意 HF 仓库(需要仓库含 tokenizer.json):
  python scripts/gen_tokenizer_refs_extra.py --model Qwen/Qwen2.5-7B-Instruct --name qwen2.5 --family qwen

  # 网络受限时: 浏览器下载 tokenizer.json 后离线生成:
  python scripts/gen_tokenizer_refs_extra.py --local /path/to/tokenizer.json --name qwen2.5 --family qwen

  # HF 主站不通时可换镜像:
  python scripts/gen_tokenizer_refs_extra.py --preset qwen2.5 --hf-endpoint https://hf-mirror.com

生成后无需重启任何服务 —— water-audit 每次运行都直接读取该 JSON。
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "src" / "references" / "canonical-strings.json"
OUT = ROOT / "src" / "references" / "tokenizer-counts.json"

# 内置预设: 词表来源仓库与覆盖范围(写入参考表,便于审计报告溯源)
PRESETS = {
    "qwen2.5": {
        "repo": "Qwen/Qwen2.5-7B-Instruct",
        "name": "qwen2.5",
        "family": "qwen",
        "models": "Qwen2 / Qwen2.5 / Qwen3 同族词表(阿里通义千问开源系)",
        "note": "Qwen3 官方仓库词表与 Qwen2.5 同源;若需严格对表请用 --preset qwen3",
    },
    "qwen3": {
        "repo": "Qwen/Qwen3-8B",
        "name": "qwen3",
        "family": "qwen",
        "models": "Qwen3 系列(阿里通义千问)",
    },
    "deepseek-v3": {
        "repo": "deepseek-ai/DeepSeek-V3",
        "name": "deepseek-v3",
        "family": "deepseek",
        "models": "DeepSeek-V3 / V3.1 / V3.2 与 DeepSeek-R1 系(deepseek-chat / deepseek-reasoner 服务端)",
    },
    "glm-4": {
        "repo": "THUDM/glm-4-9b-chat",
        "name": "glm-4",
        "family": "glm",
        "models": "GLM-4 / GLM-4.5 / ChatGLM 系(智谱开源系)",
    },
    "gemma-2": {
        "repo": "google/gemma-2-9b-it",
        "name": "gemma-2",
        "family": "gemma",
        "models": "Gemma-2 / Gemma-3 文本词表(Google 开源系)",
    },
}


def fetch_tokenizer_json(repo: str, hf_endpoint: str) -> Path:
    """下载 <repo>/resolve/main/tokenizer.json 到临时目录。"""
    url = f"{hf_endpoint.rstrip('/')}/{repo}/resolve/main/tokenizer.json"
    print(f"下载 {url} …")
    req = urllib.request.Request(url, headers={"User-Agent": "water-audit/0.1"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    tmp = ROOT / ".tmp-tokenizer.json"
    tmp.write_bytes(data)
    print(f"已保存 {tmp}({len(data) // 1024} KiB)")
    return tmp


def encode_counts(tok_path: Path, strings: list[str]) -> list[int]:
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(tok_path))
    counts = []
    for s in strings:
        ids = tok.encode(s, add_special_tokens=False).ids
        counts.append(len(ids))
    return counts


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=False)
    g.add_argument("--preset", choices=sorted(PRESETS))
    g.add_argument("--model", help="HuggingFace 仓库名,如 Qwen/Qwen2.5-7B-Instruct")
    g.add_argument("--local", help="本地 tokenizer.json 路径(离线模式)")
    ap.add_argument("--name", help="写入参考表的分词器键名(preset 自动给出)")
    ap.add_argument("--family", help="家族标签 qwen/deepseek/glm/...(preset 自动给出)")
    ap.add_argument("--models", help="覆盖模型说明(preset 自动给出)")
    ap.add_argument("--hf-endpoint", default="https://huggingface.co", help="默认官方,可换 https://hf-mirror.com")
    ap.add_argument("--remove", help="从参考表中删除指定键名后退出")
    args = ap.parse_args()

    # 删除模式
    if args.remove:
        data = json.loads(OUT.read_text(encoding="utf-8"))
        if args.remove in data["tokenizers"]:
            del data["tokenizers"][args.remove]
            OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"已删除 {args.remove},剩余 {len(data['tokenizers'])} 个分词器")
        else:
            print(f"未找到 {args.remove}")
        return 0

    if not (args.preset or args.model or args.local):
        ap.error("需要 --preset / --model / --local 之一(或 --remove)")

    if not OUT.exists():
        print("错误: 先运行 gen_tokenizer_refs.py 生成基础参考表", file=sys.stderr)
        return 1

    strings = json.loads(CANONICAL.read_text(encoding="utf-8"))["strings"]

    if args.preset:
        p = PRESETS[args.preset]
        name, family = p["name"], p["family"]
        models_desc = args.models or p["models"]
        repo, note = p["repo"], p.get("note")
        tok_path = fetch_tokenizer_json(repo, args.hf_endpoint)
        source = f"HuggingFace {repo}/tokenizer.json(官方词表)"
    elif args.local:
        name = args.name or Path(args.local).stem
        family = args.family or "unknown"
        models_desc = args.models or "未注明(本地提供)"
        tok_path = Path(args.local)
        repo, note = None, None
        source = f"本地文件 {tok_path}(请自行确认词表官方来源)"
    else:
        name = args.name or args.model.split("/")[-1].lower()
        family = args.family or "unknown"
        models_desc = args.models or args.model
        repo, note = args.model, None
        tok_path = fetch_tokenizer_json(args.model, args.hf_endpoint)
        source = f"HuggingFace {args.model}/tokenizer.json(官方词表)"

    counts = encode_counts(tok_path, strings)
    if any(c <= 0 for c in counts):
        print(f"错误: 存在 0/负计数 {counts},分词器加载方式可能有误", file=sys.stderr)
        return 1

    if args.preset or args.model:
        tok_path.unlink(missing_ok=True)  # 清理临时文件

    data = json.loads(OUT.read_text(encoding="utf-8"))
    entry = {
        "family": family,
        "models": models_desc,
        "source": source,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        "counts": counts,
    }
    if note:
        entry["note"] = note
    data["tokenizers"][name] = entry
    data["generatedAt"] = entry["generatedAt"]
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"[ok] {name}: 已合并进 {OUT}")
    print(f"     counts[:6] = {counts[:6]}")
    print(f"     覆盖: {models_desc}")
    print(f"现在可直接审计: water-audit --model <声称的{family}系模型> …(分词器维度会自动使用该参考)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
