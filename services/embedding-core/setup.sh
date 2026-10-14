#!/usr/bin/env bash
# brandsale 嵌入服务（EmbeddingGemma 2）· 一次性环境准备
#
#   bash services/embedding-core/setup.sh
#
# 做两件事：建 venv → 装 requirements.txt → 预下载模型权重。
# 幂等，重复执行安全。
#
# 为什么要把权重**预下载**到本地 models/ 而不是让服务启动时现拉：
#   1. 运行时不该依赖外网。服务起不来时，网关的 kb_retrieve 会退化成纯 BM25，
#      而"起不来"若是网络问题，排障方向会被带偏。
#   2. 本机直连 huggingface.co 不通（实测超时），必须走镜像。
#      把 HF_ENDPOINT 固化在这里，比散落在运行时环境变量里可靠。
#   3. 权重约 1.5GB，放 models/ 便于确认版本、也便于离线迁移。
#
# 可覆盖的环境变量：
#   BM_EMBED_PYTHON     Python 解释器（默认 python3，需 >= 3.10）
#   BM_EMBED_PIP_INDEX  pip 索引源（默认官方 PyPI；mirror 可能滞后于新版本）
#   BM_EMBED_HF_ENDPOINT HuggingFace 端点（默认 hf-mirror.com）
#   BM_EMBED_SKIP_MODEL 置 1 则跳过权重下载（只装依赖）
set -euo pipefail
cd "$(dirname "$0")"

PY="${BM_EMBED_PYTHON:-}"
if [ -z "$PY" ]; then
  # 自动挑一个 >= 3.10 的解释器：系统自带的 python3 在 macOS 上常常是 3.9，
  # 而 torch / transformers 5.x 都不支持它。按版本从高到低探测。
  for cand in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$cand" >/dev/null 2>&1; then
      if "$cand" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null; then
        PY="$cand"
        break
      fi
    fi
  done
fi

if [ -z "$PY" ] || ! command -v "$PY" >/dev/null 2>&1; then
  echo "[embedding-core] 找不到 Python >= 3.10 的解释器。" >&2
  echo "                请安装后重试，或用 BM_EMBED_PYTHON=/path/to/python3.13 指定。" >&2
  exit 1
fi
# 默认**官方 PyPI**，不是清华镜像——本项目的依赖里有 transformers 5.19.0 这类
# 刚发布的版本，镜像站同步有延迟，跟不上会直接装出旧版（而低版本的行为差异是静默的）。
# 若直连慢，可显式换镜像：BM_EMBED_PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
PIP_INDEX="${BM_EMBED_PIP_INDEX:-}"
HF_ENDPOINT_="${BM_EMBED_HF_ENDPOINT:-https://hf-mirror.com}"
MODEL_ID="${BM_EMBED_MODEL_ID:-google/embeddinggemma-2}"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "[embedding-core] 找不到 Python 解释器 '$PY'。请安装 Python >= 3.10，或用 BM_EMBED_PYTHON 指定路径。" >&2
  exit 1
fi

echo "[embedding-core] 解释器：$("$PY" --version 2>&1)"

if [ ! -d .venv ]; then
  echo "[embedding-core] 创建虚拟环境 .venv"
  "$PY" -m venv .venv
fi

PIP_ARGS=(install)
[ -n "$PIP_INDEX" ] && PIP_ARGS+=(-i "$PIP_INDEX")

echo "[embedding-core] 升级 pip"
./.venv/bin/python -m pip install --upgrade pip "${PIP_ARGS[@]:1}" >/dev/null

echo "[embedding-core] 安装依赖（requirements.txt${PIP_INDEX:+, index=$PIP_INDEX}）"
./.venv/bin/python -m pip "${PIP_ARGS[@]}" -r requirements.txt

if [ "${BM_EMBED_SKIP_MODEL:-0}" = "1" ]; then
  echo "[embedding-core] 已按 BM_EMBED_SKIP_MODEL=1 跳过权重下载。"
else
  echo "[embedding-core] 预下载模型权重 ${MODEL_ID}（约 1.5GB，endpoint=${HF_ENDPOINT_}）"
  HF_ENDPOINT="$HF_ENDPOINT_" ./.venv/bin/python - "$MODEL_ID" <<'PYEOF'
import os, sys
from huggingface_hub import snapshot_download

model_id = sys.argv[1]
target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", model_id.split("/")[-1])
os.makedirs(target, exist_ok=True)
# allow_patterns 刻意排除不用的模态编码器权重与示例图：
# 我们只做文本嵌入，vision/audio 的权重（若有独立文件）拉下来纯属浪费带宽。
path = snapshot_download(
    repo_id=model_id,
    local_dir=target,
    allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.jinja"],
    ignore_patterns=["*.md", "*.png", "*.jpg", "*.jpeg", "*.mp4", "*.wav"],
    max_workers=4,
)
print(f"[embedding-core] 权重就绪：{path}")
PYEOF
fi

echo "[embedding-core] 完成。启动：./.venv/bin/python serve.py"
