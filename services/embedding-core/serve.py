#!/usr/bin/env python
"""
brandsale 嵌入服务 —— EmbeddingGemma 2（google/embeddinggemma-2）

对外暴露 OpenAI 兼容的 `POST /v1/embeddings`，外加 `GET /health` 与
`POST /v1/embeddings/selftest`（自检，不需要客户端准备语料）。

为什么是一个常驻 HTTP 服务、而不是"每次调用起一个脚本"：
    270M 文本塔在 CPU/MPS 上加载一次要若干秒。入库一份报告要嵌入几十上百个 chunk，
    按请求起进程会把绝大部分时间花在加载权重上。常驻进程 + 一次性预热是唯一合理的形态。

设计约束（都来自官方模型卡，**改动前请先读** `docs/report-summary-vectordb-integration-plan.md`）：

  1. **只载文本塔**：`config_kwargs={"vision_config": None, "audio_config": None}`
     → 有效参数 270M（而非 740M），省内存也省加载时间。
     本项目当前只做文本检索；将来要按图/音检索时再打开对应编码器，
     **向量空间是同一个 768 维，不需要重建库**——这是它比纯文本模型强的地方。

  2. **禁止 float16**。模型卡的原文警告：EmbeddingGemma 2 的激活值范围超过 float16 的
     动态范围，用 float16 会返回 NaN 或静默劣化的向量，**而且不报错**。
     所以这里默认 float32（CPU/MPS 都安全）。CUDA 上可切 bfloat16。

  3. **任务前缀不能省**。模型是 task-steered 的，检索场景必须查询/文档分别用不同前缀：
         查询 → `task: search result | query: {q}`
         文档 → `title: {title} | text: {content}`
     省略"仍能工作，但精度下降"——**是静默劣化**。前缀由 sentence-transformers 的
     `prompt_name` 机制注入（模型自带 config_sentence_transformers.json 已定义好）。

  4. **截断后必须重新归一化**。MRL 截断只是"取前 N 维"，单位向量被切片后不再是单位长度。
     不重新归一化会让余弦相似度排序静默变差（算出来的分看着合理，但不报错）。
     `sentence-transformers` 在同时给 `truncate_dim` 与 `normalize_embeddings=True` 时会处理，
     这里再做一次防御性归一化。

可覆盖的环境变量：
    EMBED_MODEL_ID      模型 id 或本地目录（默认 models/embeddinggemma-2，回退到 HF id）
    EMBED_MODEL_DIR     本地权重目录（默认 <脚本目录>/models/embeddinggemma-2）
    EMBED_TEXT_ONLY     1=只载文本塔（默认 1）；0=全模态
    EMBED_DIM           输出维度，768/512/256/128（默认 768）
    EMBED_DEVICE        cpu / mps / cuda（默认自动）
    EMBED_DTYPE         float32 / bfloat16（默认 float32）
    EMBED_PORT          HTTP 端口（默认 8899）
    EMBED_HOST          绑定地址（默认 127.0.0.1，**不要绑 0.0.0.0**）
    EMBED_MAX_BATCH     单次请求最大条数（默认 64）

手工启动：
    ./services/embedding-core/.venv/bin/python services/embedding-core/serve.py
"""

from __future__ import annotations

import os
import sys
import time
import logging
from contextlib import asynccontextmanager
from typing import Any, Literal

logging.basicConfig(level=logging.INFO, format="[embedding-core] %(levelname)s %(message)s")
log = logging.getLogger("embedding-core")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LOCAL_DIR = os.path.join(HERE, "models", "embeddinggemma-2")

MODEL_ID = os.environ.get("EMBED_MODEL_ID", "")
MODEL_DIR = os.environ.get("EMBED_MODEL_DIR", DEFAULT_LOCAL_DIR)
TEXT_ONLY = os.environ.get("EMBED_TEXT_ONLY", "1") != "0"
DIM = int(os.environ.get("EMBED_DIM", "768"))
DEVICE = os.environ.get("EMBED_DEVICE", "")
DTYPE = os.environ.get("EMBED_DTYPE", "float32")
PORT = int(os.environ.get("EMBED_PORT", "8899"))
HOST = os.environ.get("EMBED_HOST", "127.0.0.1")
MAX_BATCH = int(os.environ.get("EMBED_MAX_BATCH", "64"))

SUPPORTED_DIMS = (768, 512, 256, 128)

# sentence-transformers 的 prompt 名称。
# 刻意用官方 README Quick Start 里的名字（SearchQuery / Document），而不是它们等值的
# 短别名（query / document）——两者在 config_sentence_transformers.json 里取的是同一段前缀，
# 但用文档里的名字能让人一眼对上官方示例，少一层"这个字符串对不对"的心智负担。
PROMPT_QUERY = "SearchQuery"  # → "task: search result | query: "
PROMPT_DOCUMENT = "Document"  # → "title: none | text: "

_state: dict[str, Any] = {"model": None, "loaded_at": None, "resolve_as": None}


def _resolve_model() -> str:
    """优先用本地预下载目录，回退到 HF 仓库 id。"""
    if MODEL_ID:
        return MODEL_ID
    if os.path.isdir(MODEL_DIR) and os.path.exists(os.path.join(MODEL_DIR, "config.json")):
        return MODEL_DIR
    fallback = "google/embeddinggemma-2"
    log.warning("本地权重目录不存在（%s），回退到 HF 仓库 %s —— 首次加载会联网下载", MODEL_DIR, fallback)
    return fallback


def load_model() -> None:
    import torch
    from sentence_transformers import SentenceTransformer

    src = _resolve_model()

    if DEVICE:
        device = DEVICE
    else:
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"

    dtype = torch.float32
    if DTYPE == "bfloat16":
        if device == "cuda":
            dtype = torch.bfloat16
        else:
            log.warning("bfloat16 仅在 CUDA 上启用；当前 device=%s，回退 float32", device)
    elif DTYPE != "float32":
        log.warning("不支持的 EMBED_DTYPE=%s，回退 float32", DTYPE)

    config_kwargs: dict[str, Any] = {}
    if TEXT_ONLY:
        # 关掉视觉/音频编码器：有效参数 740M → 270M
        config_kwargs = {"vision_config": None, "audio_config": None}

    log.info("加载模型：%s（device=%s, dtype=%s, text_only=%s）", src, device, dtype, TEXT_ONLY)
    t0 = time.time()
    model = SentenceTransformer(
        src,
        device=device,
        model_kwargs={"torch_dtype": dtype},
        config_kwargs=config_kwargs or None,
    )
    model.eval()
    _state["model"] = model
    _state["resolve_as"] = src
    _state["loaded_at"] = time.time()
    log.info("加载完成，用时 %.1fs", time.time() - t0)


def encode_texts(
    texts: list[str],
    *,
    input_type: Literal["query", "document"] = "document",
    title: str | None = None,
    dim: int = DIM,
) -> list[list[float]]:
    """把文本编码成向量。

    前缀注入规则（**这里是最容易出错的地方，改动请谨慎**）：
      · input_type="query"    → 用 prompt_name="SearchQuery"
      · input_type="document" 且**没有**标题 → 用 prompt_name="Document"（等价于 `title: none | text: `）
      · input_type="document" 且**有**标题   → 手动拼 `title: {t} | text: {c}`，**不能再传 prompt_name**
        （模型自带的 Document 前缀写死了 `title: none`，如果既传 prompt_name 又手拼标题，
          会变成 `title: none | text: title: X | text: ...`，前缀叠前缀，静默劣化）
    """
    model = _state["model"]
    if model is None:
        raise RuntimeError("模型尚未加载")

    prompt_name: str | None
    payload: list[str]
    if input_type == "query":
        prompt_name = PROMPT_QUERY
        payload = list(texts)
    elif title:
        prompt_name = None
        payload = [f"title: {title} | text: {t}" for t in texts]
    else:
        prompt_name = PROMPT_DOCUMENT
        payload = list(texts)

    kwargs: dict[str, Any] = {"normalize_embeddings": True, "batch_size": min(32, max(1, len(payload)))}
    if prompt_name:
        kwargs["prompt_name"] = prompt_name
    if dim != 768:
        if dim not in SUPPORTED_DIMS:
            raise ValueError(f"不支持的维度 {dim}，允许 {SUPPORTED_DIMS}")
        kwargs["truncate_dim"] = dim

    vecs = model.encode(payload, **kwargs)

    out: list[list[float]] = []
    for row in vecs:
        vals = [float(x) for x in row]
        if dim != 768:
            vals = vals[:dim]
            # 防御性重新归一化：截断破坏了单位长度，不补这一步排序会静默变差
            norm = sum(v * v for v in vals) ** 0.5
            if norm > 0:
                vals = [v / norm for v in vals]
        out.append(vals)
    return out


# ── HTTP 层 ────────────────────────────────────────────────────────────────

# 请求模型刻意定义在**模块级**，而不是 build_app() 内部。
# 原因是本文件顶部有 `from __future__ import annotations`：所有注解都变成字符串，
# FastAPI 需要按名字去解析它们。局部类在模块 globals 里找不到，
# FastAPI 就会退化成"把参数当 query 处理"，报
#   {"loc":["query","req"],"msg":"Field required"}
# —— 看起来像"请求体没传对"，实际是模型定义位置的问题。
from pydantic import BaseModel, Field as PydField  # noqa: E402


class EmbedRequest(BaseModel):
    input: str | list[str]
    model: str | None = None
    input_type: Literal["query", "document"] = "document"
    title: str | None = None
    dimensions: int | None = PydField(default=None, description="MRL 截断维度：768/512/256/128")


def build_app():
    from fastapi import FastAPI, HTTPException

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        load_model()
        yield

    app = FastAPI(title="brandsale embedding-core", version="1.0.0", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict[str, Any]:
        m = _state["model"]
        return {
            "ok": m is not None,
            "model": _state["resolve_as"],
            "dim": DIM,
            "text_only": TEXT_ONLY,
            "device": str(getattr(m, "device", "?")) if m is not None else None,
            "dtype": DTYPE,
            "loadedAt": _state["loaded_at"],
        }

    @app.post("/v1/embeddings")
    def embeddings(req: EmbedRequest) -> dict[str, Any]:
        texts = [req.input] if isinstance(req.input, str) else list(req.input)
        if not texts:
            raise HTTPException(status_code=400, detail="input 不能为空")
        if len(texts) > MAX_BATCH:
            raise HTTPException(status_code=400, detail=f"单次最多 {MAX_BATCH} 条，收到 {len(texts)}")
        if any(not isinstance(t, str) or not t.strip() for t in texts):
            raise HTTPException(status_code=400, detail="input 中存在空字符串")

        dim = req.dimensions or DIM
        t0 = time.time()
        try:
            vecs = encode_texts(texts, input_type=req.input_type, title=req.title, dim=dim)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

        elapsed = time.time() - t0
        log.info("嵌入 %d 条（type=%s, dim=%d），用时 %.3fs", len(texts), req.input_type, dim, elapsed)
        return {
            "object": "list",
            "model": _state["resolve_as"],
            "data": [
                {"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vecs)
            ],
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
            "meta": {
                "input_type": req.input_type,
                "title": req.title,
                "dim": dim,
                "count": len(texts),
                "elapsedMs": round(elapsed * 1000, 1),
            },
        }

    @app.post("/v1/embeddings/selftest")
    def selftest() -> dict[str, Any]:
        """自检：用一组中文对照句直观验证语义排序是否合理。"""
        query = "小红书美妆赛道的种草投放怎么打"
        corpus = [
            "小红书平台的美妆品类内容种草与达人投放策略复盘",       # 应最相关
            "抖音直播间的流量投放与千川出价技巧",                   # 平台不同、品类不同
            "供应链管理中的库存周转率优化",                         # 完全无关
            "B站科技区UP主商业合作报价参考",                        # 平台不同、品类不同
        ]
        t0 = time.time()
        qv = encode_texts([query], input_type="query")[0]
        dv = encode_texts(corpus, input_type="document", title=None)
        scored = sorted(
            (
                {"text": t, "score": round(sum(a * b for a, b in zip(qv, d)), 6)}
                for t, d in zip(corpus, dv)
            ),
            key=lambda x: -x["score"],
        )
        return {
            "query": query,
            "dim": DIM,
            "elapsedMs": round((time.time() - t0) * 1000, 1),
            "ranking": scored,
            "topHit": scored[0]["text"] if scored else None,
        }

    return app


def main() -> None:
    import uvicorn

    if DIM not in SUPPORTED_DIMS:
        raise SystemExit(f"EMBED_DIM={DIM} 不支持，允许 {SUPPORTED_DIMS}")

    if "--selftest" in sys.argv:
        load_model()
        r = encode_texts(["测试文本"], input_type="document")
        print(f"selftest ok: dim={len(r[0])}, 前 5 维={[round(x, 4) for x in r[0][:5]]}")
        return

    log.info("启动 HTTP 服务 %s:%d（模型在 lifespan 中加载）", HOST, PORT)
    uvicorn.run(build_app(), host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
