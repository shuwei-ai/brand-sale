# Docker 部署 · 镜像清单分析

> 回答：**Docker 化需要几个镜像？**
> 短答：**最少 1 个，推荐 5 个，全量 6 个**（+ 反代 7 个）。其中**只有 1 个 Dockerfile 是现成的**，
> 另外 2 个应用镜像需要新写；其余是官方镜像直接 pull。

---

## 1. 结论速览

| 方案 | 镜像数 | 自建 | 官方 | 适用 |
|---|---|---|---|---|
| **A. 最小可用**（纯报告能力） | **1** | 1 | 0 | 只要联网检索 + KB + 模型出报告 |
| **B. 推荐**（+ 语义检索） | **5** | 2 | 3 | A + Milvus/嵌入服务 |
| **C. 全量**（+ 平台采集） | **6** | 3 | 3 | B + 七平台公开内容采集 |
| **C+. 对外服务**（+ 反代） | **7** | 3 | 4 | C 再加 nginx/caddy 做 TLS 与鉴权前置 |

> 与同类系统的最大差异：**不需要为数据库、缓存、消息队列建任何镜像**（见 §3）。

---

## 2. 逐个镜像清单

| # | 镜像 | 来源 | 必需性 | 预估体积 | 说明 |
|---|---|---|---|---|---|
| 1 | `brandsale/gateway` | ⚠️ **需新写 Dockerfile** | **必需** | ~600 MB | Node 22 + **devDependencies** + 完整 TS 源码 + 前端构建产物 |
| 2 | `brandsale/collector` | ⚠️ **需新写 Dockerfile** | 可选 | **~1.5–2 GB** | Python 3.13 + Node + **Chromium + 系统库** + 采集内核（七平台） |
| 3 | `brandsale/embedding-core` | ✅ **Dockerfile 已有** | 可选 | ~2 GB | 权重**打进镜像**（1.4 GB），自包含、可离线迁移 |
| 4 | `milvusdb/milvus:v3.0.2` | 官方 pull | 可选 | ~1 GB | 一条 compose 里被 **2 个 service 复用**（`milvus-volume-init` + `standalone`），仍是 **1 个镜像** |
| 5 | `quay.io/coreos/etcd:v3.5.25` | 官方 pull | 随 Milvus | ~250 MB | Milvus 元数据 |
| 6 | `milvusdb/minio:RELEASE.2024-12-18T13-15-44Z` | 官方 pull | 随 Milvus | ~300 MB | Milvus 对象存储 |
| 7 | `nginx` / `caddy` | 官方 pull | 建议 | ~50 MB | TLS 终止 + 反代 + 鉴权前置 |

**镜像总量**：方案 C ≈ 6 个镜像、首次拉取/构建约 **5 GB**。

**不需要镜像的两样东西**：

- **前端**：`apps/web/dist` 由网关**同源托管**，是 gateway 镜像的**构建阶段产物**，不单独成镜像；
- **采集内核**（`services/collector-core`）：不是独立服务，是 collector **spawn 的 Python 子进程**，与 collector 同镜像。

---

## 3. 为什么镜像这么少（这是设计带来的）

| 常规系统会有 | 本项目 | 依据 |
|---|---|---|
| MySQL / PostgreSQL 容器 | ❌ 不需要 | 存储层 `driver: "sqlite"` **硬编码**（`packages/config/src/index.ts:523`）；`node:sqlite` 进程内访问 |
| Redis 容器 | ❌ 不需要 | 采集内核 `requirements.txt` 已裁掉 `redis`/`aiomysql`/`sqlalchemy`；`cache/redis_cache.py` 只剩 `__main__` 演示块，未接线 |
| MQ（RabbitMQ / Kafka） | ❌ 不需要 | 编排器在网关进程内，无独立队列 |
| Celery / worker 容器 | ❌ 不需要 | 任务状态机跑在本地事件循环 |
| 独立渲染/编排/API 服务 | ❌ 不需要 | 三者都在网关进程内（`architecture.md` §2.1） |

> ⚠️ **顺带发现一处文档漂移**：`.env.example:14` 写着 `BM_STORAGE_DRIVER=sqlite | postgres (Phase 1 仅实现 sqlite)`，
> 但 `BM_STORAGE_DRIVER` **在代码里从未被读取**——`grep` 全仓无引用，storage 的 `driver` 类型是字面量 `"sqlite"`。
> 也就是说 postgres 不只是"未实现"，而是**这个开关根本不存在**。这条应进 `docs/architecture.md` §14。

---

## 4. 三个自建镜像的难点（决定构建能不能一次成功）

### 4.1 `brandsale/gateway` — 有三个反常规点

1. **后端没有构建产物**。`npm start` 实际是 `tsx apps/gateway/src/main.ts` **直跑 TypeScript**，
   而 `tsx` 在 **devDependencies**（`package.json`）。
   → 镜像里**必须装 devDeps 并保留完整 TS 源码**，不能套用常规"多阶段 + 剪裁 node_modules"的生产 Node 镜像模板。
2. **npm workspaces**。依赖提升到根 `node_modules`（312 MB）。COPY 顺序要
   `package.json` + `package-lock.json` + `packages/*/package.json` + `apps/*/package.json` 先落地再 `npm ci`，
   否则每次改一行代码都会重装全部依赖。
3. **cwd 敏感**。`.env` 与 `BM_DATA_DIR` 都按 **`cwd`** 解析（`index.ts:509` / `:514`），
   → `WORKDIR` 必须等于**仓库根**。
   而静态产物路径是按**模块位置**解析的（`static.ts:57` `dirname(import.meta.url)/../../web/dist`），
   → 只要保住 `apps/gateway/src` 与 `apps/web/dist` 的相对关系（或设 `BM_WEB_DIST`）即可。

**必需卷**：`.data`（SQLite 真相源）、`out`（报告产物）。

### 4.2 `brandsale/collector` — 最不划算的一格，建议**先不容器化**

要装进一个镜像的东西：**Python 3.13 + Node（双运行时）+ Chromium + Playwright 系统依赖 + 采集内核**，
再加上 `pyexecjs` 需要一个 JS 运行时（正好复用镜像里的 Node）。体积直奔 **1.5–2 GB**。

更麻烦的是三个与"容器"理念冲突的点：

| 冲突点 | 事实 | 后果 |
|---|---|---|
| **首次登录需要可见窗口** | `BM_MC_HEADLESS=false`（`.env.example` 注释："扫码登录需要可见窗口"）；内核 `ENABLE_CDP_MODE=True` + `CDP_CONNECT_EXISTING=True` | 容器里必须加 **Xvfb + VNC**，把二维码显示给人扫；容器不再是"无交互" |
| **登录态 1.8 GB 且是隐私数据** | `services/collector-core/browser_data/`（含各平台 Cookie） | **绝不能 COPY 进镜像**（隐私 + 会过期）→ 必须 volume 挂载 |
| **CDP 要检测本机 Chrome/Edge** | 内核 `--cdp auto` 走 `CUSTOM_BROWSER_PATH` 自动探测 | 容器内要把 chromium 放到可被探测的路径，否则退回 playwright 自带浏览器 |

**建议**：
- **首选**：collector **不进容器**，留在宿主机以 systemd 运行（Python 环境由 `setup.sh` 一次装好）；
- **次选**：容器化但接受 Xvfb + VNC + volume 的运维复杂度，且明确它是**半人工运维动作**。

> 这与整体设计一致——"不装 Python 就没有平台数据"本来就是**渐进式可用**的一部分，
> 把 collector 排除在容器外，不会影响其他镜像的正常工作。

### 4.3 `brandsale/embedding-core` — 唯一现成的，直接用

`services/embedding-core/Dockerfile` 已经很完整：多阶段式分层（torch CPU 版单独一层 → 依赖 → 权重 → 代码）、
非 root（uid 10001）、`HEALTHCHECK`、`.dockerignore` 齐备，且**只绑 127.0.0.1**。
直接 `npm run embedding:up` 即可，无需改动。

---

## 5. 必须先补的一个文件：根 `.dockerignore` ⚠️

**当前仓库根目录没有 `.dockerignore`**（只有 `services/embedding-core/.dockerignore`）。

如果从仓库根构建 gateway 镜像，构建上下文会包含：`services/collector-core/browser_data`（1.8 GB）、
`services/embedding-core/models`（1.4 GB）、两个 `.venv`（361 MB + 1.1 GB）、`node_modules`（312 MB）、
`.data`、`.git` → **接近 8–10 GB 的上下文**，每次构建都要传给 daemon，构建会慢到不可接受。

**最小 `.dockerignore`（放仓库根）**：

```
.git
node_modules
.data
.data-*
out
.workbuddy
services/collector-core/.venv
services/collector-core/browser_data
services/collector-core/data
services/embedding-core/.venv
services/embedding-core/models
infra/milvus/volumes
*.log
.DS_Store
```

---

## 6. 推荐 compose 骨架（方案 B/C，示意）

```yaml
services:
  gateway:                                   # ① 自建（必需）
    build: { context: ., dockerfile: deploy/gateway.Dockerfile }
    image: brandsale/gateway:1.0.0
    restart: unless-stopped
    working_dir: /app                        # ★ .env / BM_DATA_DIR 按 cwd 解析
    ports: ["127.0.0.1:8787:8787"]           # ★ 只绑回环，由反代对外
    env_file: [.env]
    volumes:
      - ./data:/app/.data                    # ★ SQLite 真相源
      - ./out:/app/out                       # 报告产物
    depends_on: [embedding]                  # 可选

  collector:                                 # ② 自建（可选，见 §4.2）
    build: { context: ., dockerfile: deploy/collector.Dockerfile }
    image: brandsale/collector:1.0.0
    profiles: ["collector"]                  # ★ 默认不启动：docker compose --profile collector up
    working_dir: /app
    ports: ["127.0.0.1:8890:8890"]
    env_file: [.env]
    volumes:
      - ./services/collector-core/browser_data:/app/services/collector-core/browser_data  # ★ 1.8G 登录态
      - ./services/collector-core/data:/app/services/collector-core/data
      - ./data-collector:/app/.data-collector
    shm_size: 1g                             # ★ 浏览器必需

  embedding:                                 # ③ 现成 compose，可直接 include/复用
    image: brandsale/embedding-core:1.0.0
    build: { context: services/embedding-core }
    restart: unless-stopped
    ports: ["127.0.0.1:8899:8899"]           # 无鉴权，保持回环
    mem_limit: 3g

  # ④⑤⑥ Milvus 栈：直接用 infra/milvus/docker-compose.yml，不必重写
  #    milvusdb/milvus:v3.0.2 + quay.io/coreos/etcd:v3.5.25 + milvusdb/minio:...

  # ⑦ 反代（对外服务时加）
  # nginx: image: nginx:alpine ; ports: ["443:443"] ; …
```

> `profiles: ["collector"]` 是关键设计：让"要不要采平台数据"成为一个**显式的启动参数**，
> 与代码里"三道门缺一不装配"的思路一致——而不是默认把所有东西都拉起来。

---

## 7. 一句话总结

- **Docker 化本身不难**：必需的应用只有一个网关镜像，其余都是可缺席的增强项；
- **真正的工作量在两处**：给 gateway 写一个"不能剪裁 devDeps"的 Node 镜像（含前端构建阶段），
  以及决定 collector 到底进不进容器（**建议不进**）；
- **顺手要补的**：根 `.dockerignore`（否则构建上下文 ~8–10 GB），以及
  `.env.example` 里 `BM_STORAGE_DRIVER` 这个从未接线的变量（避免误导后续部署者去找 Postgres）。
