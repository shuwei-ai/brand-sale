#!/usr/bin/env bash
# 准备 Spider_XHS 的独立 Python 环境；不改 MediaCrawler 的 venv。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPIDER_DIR="${BM_SPIDER_XHS_DIR:-$ROOT/services/spider-xhs}"
if [[ "$SPIDER_DIR" != /* ]]; then
  SPIDER_DIR="$ROOT/$SPIDER_DIR"
fi

if [[ ! -f "$SPIDER_DIR/requirements.txt" ]]; then
  echo "找不到 Spider_XHS：$SPIDER_DIR" >&2
  echo "先执行：git clone --depth 1 https://github.com/cv-cat/Spider_XHS.git services/spider-xhs" >&2
  exit 1
fi

PYTHON_BIN="${PYTHON_BIN:-python3}"
"$PYTHON_BIN" -m venv "$SPIDER_DIR/.venv"
"$SPIDER_DIR/.venv/bin/python" -m pip install --upgrade pip
"$SPIDER_DIR/.venv/bin/python" -m pip install -r "$SPIDER_DIR/requirements.txt"
# 上游 requirements.txt 漏列 cryptography，但 xhs_utils/xhs_core/ssk.py 实际 import 它
"$SPIDER_DIR/.venv/bin/python" -m pip install cryptography

# 签名 JS 需要 crypto-js（本地 Node 运行时执行，PyExecJS 驱动）
if [[ -f "$SPIDER_DIR/package.json" ]]; then
  (cd "$SPIDER_DIR" && npm install)
fi

# 自检只 import 本地代码与检查 JS 运行时，不访问小红书、不需要登录。
"$SPIDER_DIR/.venv/bin/python" "$ROOT/apps/collector/py/spider_xhs_runner.py" \
  --op probe --spider-dir "$SPIDER_DIR"

echo "Spider_XHS 环境就绪。设置 BM_XHS_DRIVER=spider 后重启 npm run collector。"
