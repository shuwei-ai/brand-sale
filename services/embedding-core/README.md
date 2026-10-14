# services/embedding-core —— 嵌入服务（EmbeddingGemma 2）

把 `google/embeddinggemma-2` 起成一个常驻的 HTTP 服务，对外提供 OpenAI 兼容的
`POST /v1/embeddings`。集成侧的类在 `packages/knowledge/src/semantic-memory.ts`。

> **为什么是常驻服务而不是"每次调用起个脚本"**：270M 文本塔加载一次要几秒，
> 而入库一份报告要嵌入几十上百个 chunk。按请求起进程会把时间全花在加载权重上。

有两种运行方式，**对外给智能体调用建议用 Docker**（自包含、不依赖宿主 Python 环境）：

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| **Docker（推荐）** | `npm run embedding:up` | 集成/部署。容器自包含，只暴露 `127.0.0.1:8899` |
| 原生（开发用） | `npm run embedding:setup` 后跑 `serve.py` | 本机调模型、改代码时热重启更快（可用 MPS） |

---

## Docker 部署（对外提供 API）

把服务连同权重一起封成自包含镜像，起来后在 `http://127.0.0.1:8899` 提供 API，
供品牌营销智能体调用——`packages/knowledge/src/semantic-memory.ts` 的
`semanticMemoryFromEnv()` 里 `BM_EMBED_URL` 默认就指向这个地址，**不用额外配**。

```bash
npm run embedding:up      # = docker compose -f services/embedding-core/docker-compose.yml up -d --build
npm run embedding:logs    # 跟踪日志
npm run embedding:down    # 停止并删除容器
```

首次构建会下载 CPU 版 torch 与依赖（约 300MB），并把 1.4GB 权重打包进镜像，
镜像约 2GB。之后改 `serve.py` 只重建末尾那一层，很快。

起来后自检：

```bash
curl http://127.0.0.1:8899/health
curl -X POST http://127.0.0.1:8899/v1/embeddings/selftest
```

### 与原生运行的三条差异（都会踩）

| # | 差异 | 说明 |
| --- | --- | --- |
| 1 | **容器里没有 MPS** | Docker Desktop for Mac 不做 GPU/ANE 透传，torch 只能用 CPU。compose 固定 `EMBED_DEVICE=cpu`。**向量口径不变**（float32，禁用 float16），只是单批耗时略长。 |
| 2 | **torch 走 CPU 专用索引** | Linux 上 PyPI 的 torch 默认是 CUDA 构建，会连带拖进 2GB+ 的 `nvidia-*` 运行时库，而容器没有 GPU。Dockerfile 用 `download.pytorch.org/whl/cpu` 只装 CPU 版，并钉死 `torch==2.14.1` / `torchvision==0.29.1`（与宿主 venv 同版本，保证向量逐位可比）。 |
| 3 | **权重在构建期进镜像** | 运行期不依赖外网——服务起不来若是网络问题，排障方向会被带偏。代价是镜像约 2GB，换来自包含与离线可迁移。 |

### 端口与暴露面

发布为 `127.0.0.1:8899:8899`（与 `infra/milvus` 同口径），**只绑回环**。
本服务**无鉴权**，不要改成 `0.0.0.0` 暴露到局域网。

> 容器内 `EMBED_HOST` 必须是 `0.0.0.0`，否则宿主端口映射进来会被拒。
> 这与「宿主上别绑 `0.0.0.0`」不矛盾——真正的暴露面由 compose 的 `ports` 决定。

### 端口冲突

宿主原生的 `serve.py` 也占用 8899。切到容器前先停掉，否则 `up` 会因端口被占失败：

```bash
pkill -f "embedding-core/serve.py"
```

---

## 原生运行（本机开发）

### 前置与安装

需要 **Python ≥ 3.10**（`transformers 5.19` 与 `torch` 都不支持 3.9）。

```bash
npm run embedding:setup        # 建 venv → 装依赖 → 预下载权重（约 1.4GB）
```

脚本会按 `python3.13 → 3.12 → 3.11 → 3.10 → python3` 的顺序自动挑一个够新的解释器；
也可用 `BM_EMBED_PYTHON=/path/to/python3.13` 指定。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `BM_EMBED_PYTHON` | 自动探测 | Python 解释器 |
| `BM_EMBED_PIP_INDEX` | 官方 PyPI | 换成镜像，如 `https://pypi.tuna.tsinghua.edu.cn/simple` |
| `BM_EMBED_HF_ENDPOINT` | `https://hf-mirror.com` | 权重下载端点 |
| `BM_EMBED_SKIP_MODEL` | `0` | 置 1 只装依赖、不下载权重 |

> 默认 pip 源刻意用**官方 PyPI** 而非清华镜像：依赖里有 `transformers 5.19.0` 这类
> 刚发布的版本，镜像同步有延迟，跟不上就会装出旧版——而**低版本的行为差异是静默的**。

---

### 启动

```bash
./services/embedding-core/.venv/bin/python services/embedding-core/serve.py
curl http://127.0.0.1:8899/health
```

首次启动约 1~2 秒即可加载完（MPS 上实测 1.2s）。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `EMBED_PORT` / `EMBED_HOST` | `8899` / `127.0.0.1` | **别绑 `0.0.0.0`** |
| `EMBED_DIM` | `768` | MRL 截断：768 / 512 / 256 / 128 |
| `EMBED_TEXT_ONLY` | `1` | 只载文本塔（740M → 270M） |
| `EMBED_DEVICE` | 自动（mps/cuda/cpu） | |
| `EMBED_DTYPE` | `float32` | 仅 CUDA 上会自动用 bfloat16 |
| `EMBED_MODEL_DIR` | `./models/embeddinggemma-2` | 本地权重目录 |

---

## 接口

### `GET /health`

```json
{"ok":true,"model":".../models/embeddinggemma-2","dim":768,"text_only":true,"device":"mps:0","dtype":"float32"}
```

### `POST /v1/embeddings`

```bash
curl -X POST http://127.0.0.1:8899/v1/embeddings -H 'Content-Type: application/json' -d '{
  "input": ["小红书美妆种草怎么投"],
  "input_type": "query"
}'
```

| 字段 | 说明 |
| --- | --- |
| `input` | 字符串或字符串数组 |
| `input_type` | **`"query"` 或 `"document"`，必填语义**，见下 |
| `title` | 仅 `input_type="document"` 时有意义 |
| `dimensions` | 覆盖截断维度 |

### `POST /v1/embeddings/selftest`

用一组中文对照句验证语义排序是否符合直觉，**不需要客户端准备语料**：

```bash
curl -X POST http://127.0.0.1:8899/v1/embeddings/selftest
```

---

## 六个必须知道的坑（全部踩过）

| # | 坑 | 现象 | 处置 |
| --- | --- | --- | --- |
| 1 | **必须装 `pillow`** | 加载即 `ImportError: EmbeddingGemma2Processor requires the PIL library` | 已在 requirements 里；与用不用图像无关，是 processor 的构造依赖 |
| 2 | **必须装 `torchvision`** | `ModuleNotFoundError: Could not import module 'EmbeddingGemma2Processor'`——**真正的根因被 transformers 包装吞掉了**，要开 DEBUG 才看得到 `No module named 'torchvision'` | 已在 requirements 里；import 链是 `EmbeddingGemma2Processor → gemma4/image_processing_gemma4 → torchvision.transforms.v2` |
| 3 | **禁用 float16** | 模型卡原文警告：激活值超出 float16 动态范围，会返回 **NaN 或静默劣化的向量**，**不报错** | 本服务固定 `float32`（CPU/MPS），仅 CUDA 上用 `bfloat16` |
| 4 | **任务前缀不能省** | 省略"仍能工作，但精度下降"——静默劣化 | 查询走 `SearchQuery`、文档走 `Document`（官方 README 的写法）。**有标题的文档要手动拼 `title: {t} \| text: {c}` 且不能再传 prompt_name**，否则前缀会叠成 `title: none \| text: title: X \| text: ...` |
| 5 | **截断后必须重新归一化** | MRL 取前 N 维会破坏单位长度，不归一化则排序静默变差 | 服务内部已补，且查询与文档共用同一 `dim` |
| 6 | **huggingface.co 直连不通** | 下载超时 | setup 默认走 `hf-mirror.com`；也可用代理 `-x http://127.0.0.1:7897` |

---

## 实测数据（2026-10-12，Apple M5 Pro / MPS）

| 项 | 值 |
| --- | --- |
| 模型加载 | 1.2s |
| 依赖版本 | sentence-transformers 6.1.0 / transformers 5.19.0 / torch 2.14.1 / torchvision 0.29.1 |
| 权重体积 | 1.4GB（13 个文件） |
| 输出维度 | 768 |
| 语义自检 | 查询「小红书美妆赛道的种草投放怎么打」→ 正确把「小红书平台的美妆品类内容种草」排第一（0.890），把「供应链管理中的库存周转率优化」排最后（0.610） |

> 注意：该模型家族的相似度**整体偏高**（不相关的中文句子也有 0.6 左右），
> 因此**不要用固定阈值判断"是否相关"**，应当用相对排序（topK）或按业务语料实测标定阈值。

---

## 文本专用加载

`EMBED_TEXT_ONLY=1`（默认）通过 `config_kwargs={"vision_config": None, "audio_config": None}`
关掉视觉/音频编码器，有效参数从 740M 降到 270M。

将来要按图/音检索时打开对应编码器即可——**向量空间是同一个 768 维，不需要重建索引库**。
