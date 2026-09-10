#!/usr/bin/env python3
"""
分词器指纹参考表生成脚本(OpenAI 系 + Llama 系)。

为 src/references/canonical-strings.json 中的规范字符串计算各分词器的精确
token 数,输出 src/references/tokenizer-counts.json。

可靠性设计:
  - OpenAI 四代正则直接取自本机 tiktoken 包内的 tiktoken_ext/openai_public.py
    (官方原文),不手写;词表数据来自 npm 包 gpt-tokenizer 内置的同名
    .tiktoken 文件(与 openaipublic CDN 分发文件一致),通过 monkeypatch
    注入,避免访问外网。
  - Llama-3/4 词表由 PyPI llama-models 包内置(Meta 官方 tokenizer.model),
    直接调用其官方 Tokenizer 类。
  - 计数匹配采用「相对差值法」(对锚点字符串的差值),消除 chat 模板/BOS
    常数偏移,详见 README。

依赖: pip install tiktoken llama-models
      词表数据: npm pack gpt-tokenizer(或 --npm-dir 指定解压目录)
"""
from __future__ import annotations

import argparse
import base64
import datetime
import json
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "src" / "references" / "canonical-strings.json"
OUT = ROOT / "src" / "references" / "tokenizer-counts.json"


def load_ranks(path: Path) -> dict[bytes, int]:
    """tiktoken .tiktoken 文件格式: 每行 'base64(token) rank'。"""
    import tiktoken.load

    return tiktoken.load.load_tiktoken_bpe(str(path))


def openai_entries(data_dir: Path, strings: list[str]) -> dict[str, dict]:
    import tiktoken
    import tiktoken_ext.openai_public as opub

    file_for = {
        "o200k_base": "o200k_base.tiktoken",
        "cl100k_base": "cl100k_base.tiktoken",
        "p50k_base": "p50k_base.tiktoken",
        "r50k_base": "r50k_base.tiktoken",
    }
    local_ranks = {
        name: load_ranks(data_dir / fname) for name, fname in file_for.items()
    }

    # 用本地词表替换官方下载器,再调用官方构造函数(正则/特殊 token 全部官方原文)
    opub.load_tiktoken_bpe = lambda url, **kw: local_ranks[
        url.rsplit("/", 1)[-1].removesuffix(".tiktoken")
    ]
    opub.data_gym_to_mergeable_bpe_ranks = lambda **kw: local_ranks["r50k_base"]

    constructors = {
        "o200k_base": opub.o200k_base,
        "cl100k_base": opub.cl100k_base,
        "p50k_base": opub.p50k_base,
        "r50k_base": opub.r50k_base,
    }
    entries: dict[str, dict] = {}
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    for name, ctor in constructors.items():
        spec = ctor()
        enc = tiktoken.Encoding(
            name=spec["name"],
            pat_str=spec["pat_str"],
            mergeable_ranks=spec["mergeable_ranks"],
            special_tokens=spec["special_tokens"],
        )
        counts = [len(enc.encode(s)) for s in strings]
        entries[name] = {
            "family": "openai",
            "source": f"tiktoken 官方正则 + npm gpt-tokenizer data/{file_for[name]}(与 openaipublic CDN 同源)",
            "generatedAt": now,
            "counts": counts,
        }
        print(f"[ok] {name}: {counts[:6]} ...")
    return entries


def llama_entries(strings: list[str]) -> dict[str, dict]:
    entries: dict[str, dict] = {}
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    try:
        from llama_models.llama3.tokenizer import Tokenizer as T3
        import llama_models.llama3.tokenizer as m3

        t3 = T3(Path(m3.__file__).parent / "tokenizer.model")
        entries["llama3"] = {
            "family": "llama",
            "source": "PyPI llama-models 内置 llama3/tokenizer.model(Meta 官方)",
            "generatedAt": now,
            "counts": [len(t3.encode(s, bos=False, eos=False)) for s in strings],
        }
        print(f"[ok] llama3: {entries['llama3']['counts'][:6]} ...")
    except Exception as e:  # noqa: BLE001
        print(f"[skip] llama3: {e}", file=sys.stderr)
    try:
        from llama_models.llama4.tokenizer import Tokenizer as T4
        import llama_models.llama4.tokenizer as m4

        t4 = T4(Path(m4.__file__).parent / "tokenizer.model")
        counts4 = []
        for s in strings:
            if hasattr(t4, "model"):  # llama4 内部是 tiktoken.Encoding
                counts4.append(len(t4.model.encode(s)))
            else:
                counts4.append(len(t4.encode(s, bos=False, eos=False)))
        entries["llama4"] = {
            "family": "llama",
            "source": "PyPI llama-models 内置 llama4/tokenizer.model(Meta 官方)",
            "generatedAt": now,
            "counts": counts4,
        }
        print(f"[ok] llama4: {counts4[:6]} ...")
    except Exception as e:  # noqa: BLE001
        print(f"[skip] llama4: {e}", file=sys.stderr)
    return entries


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--npm-tarball", help="gpt-tokenizer 的 .tgz(npm pack 产物)")
    ap.add_argument("--npm-dir", help="已解压的 gpt-tokenizer 包目录(含 data/*.tiktoken)")
    args = ap.parse_args()

    data_dir: Path | None = None
    if args.npm_dir:
        data_dir = Path(args.npm_dir) / "data"
    elif args.npm_tarball:
        tmp = Path(tempfile.mkdtemp(prefix="gtok"))
        with tarfile.open(args.npm_tarball) as tf:
            tf.extractall(tmp)
        data_dir = tmp / "package" / "data"
    else:
        # 尝试 npm pack(需要 registry.npmjs.org 可达)
        tmp = Path(tempfile.mkdtemp(prefix="gtok"))
        import subprocess

        subprocess.run(
            ["npm", "pack", "gpt-tokenizer@latest", "--pack-destination", str(tmp)],
            check=True, capture_output=True,
        )
        with tarfile.open(next(tmp.glob("*.tgz"))) as tf:
            tf.extractall(tmp / "x")
        data_dir = tmp / "x" / "package" / "data"

    strings = json.loads(CANONICAL.read_text(encoding="utf-8"))["strings"]
    entries: dict[str, dict] = {}
    entries.update(openai_entries(data_dir, strings))
    entries.update(llama_entries(strings))

    out = {
        "version": 1,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
        "method": "对 canonical-strings.json 每个字符串求精确 token 数;审计时按锚点相对差值匹配(消除模板常数偏移)",
        "anchorIndex": 0,
        "tokenizers": entries,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT} ({len(entries)} tokenizers)")
    return 0 if entries else 1


if __name__ == "__main__":
    raise SystemExit(main())
