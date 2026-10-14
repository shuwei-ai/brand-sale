# syntax=docker/dockerfile:1
#
# ─────────────────────────────────────────────────────────────────────────────
# brandsale 嵌入服务 · EmbeddingGemma 2（google/embeddinggemma-2）
#
# 对外提供 OpenAI 兼容的 `POST /v1/embeddings`（默认 8899），供品牌营销智能体调用。
# 构建上下文 = services/embedding-core（见同目录 .dockerignore，已排除 .venv）。
#
# 与「宿主机原生运行（.venv + MPS）」的**三处关键差异**——改动前务必先读：
#
#   1. 容器里没有 MPS。Docker Desktop for Mac 不做 GPU/ANE 透传，torch 只能用 CPU。
#      因此这里固定 EMBED_DEVICE=cpu。**依旧禁用 float16**（模型卡警告会返回 NaN 且不报错），
#      float32 在 CPU 上安全。270M 文本塔在 CPU 上嵌入一批文本仍是亚秒级，够用。
#
#   2. torch 必须走 CPU 专用索引。Linux 上 PyPI 的 torch 默认是 CUDA 构建，
#      会连带拖进 2GB+ 的 nvidia-* 运行时库，而容器根本没有 GPU。
#      改用 download.pytorch.org/whl/cpu 只装 CPU 版（约 200MB）。
#
#   3. 权重在**构建期 COPY 进来**，不在运行期下载。原因：运行时不该依赖外网——
#      服务起不来若是网络问题，排障方向会被带偏（见 setup.sh 里同样的理由）。
#      因此镜像自包含、可离线迁移；代价是镜像约 2GB。
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.13-slim

# 与宿主 venv 保持同一对版本，保证**向量结果逐位可比**（torch 2.14 ↔ torchvision 0.29）。
# 这两个包**不写进 requirements.txt**：那份是给 macOS/MPS 原生环境用的，
# 那里故意放宽（torch>=2.2）好跟随官方 wheel。这里必须钉死，否则 pip 可能从
# PyPI 拉到 CUDA 版或解析出不匹配的 torchvision。
ARG TORCH_VERSION=2.14.1
ARG TORCHVISION_VERSION=0.29.1
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TOKENIZERS_PARALLELISM=false \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    # 服务运行参数：镜像**自包含**，不用 compose 直接 docker run 也能起
    EMBED_HOST=0.0.0.0 \
    EMBED_PORT=8899 \
    EMBED_DEVICE=cpu \
    EMBED_DTYPE=float32 \
    EMBED_TEXT_ONLY=1 \
    EMBED_DIM=768 \
    EMBED_MODEL_DIR=/app/models/embeddinggemma-2

# libgomp1：torch 的 OpenMP 运行时依赖，slim 基础镜像里没有，缺了 import torch 会失败
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ① torch / torchvision 的 CPU 版。单独一层：命中缓存后，改业务依赖不必重下
RUN pip install --index-url "${TORCH_INDEX_URL}" \
      "torch==${TORCH_VERSION}" "torchvision==${TORCHVISION_VERSION}"

# ② 其余依赖。此时 requirements 里的 `torch>=2.2` / `torchvision>=0.20` 已被满足，
#    pip 不会再去 PyPI 拉 CUDA 版。
COPY requirements.txt ./
RUN pip install -r requirements.txt

# ③ 模型权重（约 1.4GB）。刻意放在服务代码**之前**：
#    Docker 逐层失效，代码改得勤，权重几乎不动——把大层放前面，改代码只重建末尾小层。
#    用 `COPY --chown` 直接以 app 的 uid:gid 落盘：若改成先 COPY 再在末尾 `chown -R`，
#    Docker 会**把这一层 1.5GB 的内容整份复制一遍**（chown 改的是元数据，但层是快照）。
COPY --chown=10001:10001 models/embeddinggemma-2/ ./models/embeddinggemma-2/

# ④ 服务代码放最后（改它只重建这一层）
COPY --chown=10001:10001 serve.py ./

# 非 root 运行。uid 10001 与上面两个 COPY --chown 对齐。
# 只建 HF 缓存目录并授权，不再 chown 整个 /app。
RUN useradd --create-home --uid 10001 app \
 && mkdir -p /app/.cache/hf \
 && chown app:app /app/.cache/hf
ENV HOME=/home/app \
    HF_HOME=/app/.cache/hf
USER app

EXPOSE 8899

# 模型在 FastAPI 的 lifespan 里加载；能返回 200 就说明模型已就绪（不是只起了进程）
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8899/health',timeout=5).status==200 else 1)"

CMD ["python", "serve.py"]
