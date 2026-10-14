#!/usr/bin/env bash
# brandsale 内嵌采集内核 · 一次性环境准备
#
#   bash services/collector-core/setup.sh
#
# 做三件事：建 venv → 装 requirements.txt → 尝试下载 playwright 的 chromium。
# 幂等，重复执行安全。
#
# 关于第三步：**不是必需的**。采集内核默认走 `--cdp auto`，只要本机装了
# Chrome 或 Edge 就直接驱动它（隔离 profile），无需 chromium 二进制。
# 只有两种情况需要 chromium：本机没装 Chrome/Edge，或显式传 `--cdp false`。
# 因此这一步失败不会让脚本退出，只打印提示。
#
# 可覆盖的环境变量：
#   BM_MC_PYTHON        Python 解释器（默认 python3，需 >= 3.11）
#   BM_MC_PIP_INDEX     pip 索引源（默认清华镜像，直连 pypi 慢时可换成官方源）
#   BM_MC_PW_HOST       playwright 浏览器下载源（默认 npmmirror）
#   BM_MC_SKIP_BROWSER  置 1 则完全跳过 chromium 下载
set -euo pipefail
cd "$(dirname "$0")"

PY="${BM_MC_PYTHON:-python3}"
# 默认走国内镜像：上游 MediaCrawler 自身也配了清华源，直连 pypi 在国内经常读超时
PIP_INDEX="${BM_MC_PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
PW_HOST="${BM_MC_PW_HOST:-https://npmmirror.com/mirrors/playwright}"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "[collector-core] 找不到 Python 解释器 '$PY'。请安装 Python >= 3.11，或用 BM_MC_PYTHON 指定路径。" >&2
  exit 1
fi

echo "[collector-core] 解释器：$("$PY" --version 2>&1)"

if [ ! -d .venv ]; then
  echo "[collector-core] 创建虚拟环境 .venv"
  "$PY" -m venv .venv
fi

echo "[collector-core] 安装依赖（requirements.txt，index=${PIP_INDEX}）"
./.venv/bin/python -m pip install --upgrade pip -i "$PIP_INDEX" >/dev/null
./.venv/bin/python -m pip install -i "$PIP_INDEX" -r requirements.txt

if [ "${BM_MC_SKIP_BROWSER:-0}" = "1" ]; then
  echo "[collector-core] 已按 BM_MC_SKIP_BROWSER=1 跳过 chromium 下载。"
else
  echo "[collector-core] 尝试下载 playwright chromium（约 150MB，download host=${PW_HOST}）"
  if PLAYWRIGHT_DOWNLOAD_HOST="$PW_HOST" ./.venv/bin/python -m playwright install chromium; then
    echo "[collector-core] chromium 就绪。"
  else
    echo "[collector-core] ⚠️  chromium 下载失败，但这**不影响**默认运行：" >&2
    echo "              采集内核默认 --cdp auto，只要有本机 Chrome/Edge 就会直接驱动它。" >&2
    echo "              仅当本机没装 Chrome/Edge、或显式传 --cdp false 时才需要 chromium。" >&2
    echo "              需要重试可用官方源：BM_MC_PW_HOST=https://cdn.playwright.dev bash services/collector-core/setup.sh" >&2
  fi
fi

echo "[collector-core] 就绪。采集内核可由 apps/collector 驱动，或手工运行 run.py。"
