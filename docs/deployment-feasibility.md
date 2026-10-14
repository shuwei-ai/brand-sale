# 部署可行性评估（as-built）

> 评估对象：当前仓库实现（以代码为准，非 PRD）。
> 结论先行：**架构上可以部署，而且是「单机单进程」的简单形态**——但能不能上生产，取决于三个必须先做的决定：
> ① 采集链路的**图形环境 + 非商用许可**；② 网关**没有真实鉴权**且默认监听全网卡；③ **优雅关闭对 SSE 无效**。
> 这三条不解决，就只能停在"内网单客户"这一档。

---

## 1. 一句话结论

| 部署场景 | 现在能不能上 | 卡点 |
|---|---|---|
| **A. 内网 / 单客户 / 演示** | ✅ 现在就能上 | 只需 1 台机器 + Node + 出网到模型端点 |
| **B. 纯报告能力**（不要平台采集） | ✅ 最省事 | 连 Python 和 Docker 都不用装，缺哪一级**显式降级**而非报错 |
| **C. 公网 / 多客户 SaaS** | ⚠️ 需先补三件事 | 鉴权（当前是自造 token 不校验）、TLS/反代、单实例容量规划 |
| **D. 集群 / 滚动更新 / 多副本** | ❌ 不支持 | SQLite 是唯一真相源 + 编排在进程内 → **只能单实例** |

**最大的架构优点**：`docs/architecture.md` §2.2 的「渐进式可用」是真的——
不装 Python 就没有平台数据；不起 Docker 就没有语义检索（退化为 BM25 + 关键词）；不配模型地址就用确定性桩。
每一级缺席都**显式降级**，不会因为缺组件起不来。这让"先上一档、再补能力"成为可行路径。

---

## 2. 运行时清单

### 2.1 进程与端口

| 组件 | 必需性 | 端口 | 形态 | 备注 |
|---|---|---|---|---|
| `apps/gateway` | **必需** | **8787** | Node 进程（`npm start`，实际跑 `tsx`） | 对外唯一入口：API + SSE + 静态托管，编排/智能体/渲染全在**本进程内** |
| `apps/collector` | 可选（要用平台数据才需要） | 8890 | Node 进程（`npm run collector`） | 只读归一化 sidecar，默认**只绑 127.0.0.1** |
| `services/collector-core` | 随 collector | 无端口 | Python 子进程（由 collector spawn） | 起真实浏览器 → 扫码 → 采集 → 落 jsonl |
| `services/embedding-core` | 可选（要语义检索才需要） | 8899 | Docker | EmbeddingGemma 2，CPU float32，无鉴权，**只绑 127.0.0.1** |
| Milvus（+etcd +MinIO） | 可选 | 19530 | Docker ×3 | 默认 `BM_VECTOR_DRIVER=memory`，**不开也能跑** |
| 前端控制台 | — | 复用 8787 | Vite 静态产物 | 网关同源托管 `apps/web/dist`，无跨域配置 |

### 2.2 主机要求

| 项 | 要求 | 依据 |
|---|---|---|
| Node | **>= 22.19.0** | 根 `package.json` `engines`；依赖 `node:sqlite` 内置模块 |
| Python | **>= 3.11**（仅平台采集需要） | `services/collector-core/setup.sh` |
| Docker | 可选（嵌入服务 / Milvus） | `services/embedding-core/docker-compose.yml`、`infra/milvus/` |
| 浏览器 | **Chrome 或 Edge**（仅平台采集需要） | 内核默认 `--cdp auto` 直接驱动本机浏览器 |
| 磁盘 | 起步 **~5 GB**，全量 **~10 GB+** | 见 2.4 |
| 内存 | 纯报告 **< 1 GB**；全量 **8 GB 以上** | embedding 限 3g + Milvus 限 3g + Node |
| 出网 | 模型端点 + 联网检索（+ 采集时的平台站点） | 见 2.3 |

### 2.3 必需的出网目标

| 目标 | 用途 | 变量 | 可否离线 |
|---|---|---|---|
| OpenAI 兼容模型端点 | 全部智能体推理 | `BM_LLM_BASE_URL` | ✅ `BM_LLM_MODE=mock` 可完全离线 |
| 火山引擎联网搜索 | `web_search` 工具 | `BM_WEB_SEARCH_URL` | 清空 KEY 即整体关闭 |
| 七平台站点 | 公开内容采集（浏览器直连） | — | 不开采集即不需要 |

**没有出网到任何第三方数据 SaaS**——外部数据只有"本地浏览器采集 + 联网搜索"两条路（见 §4）。

### 2.4 磁盘占用实测

| 路径 | 体积 | 是否入库 |
|---|---|---|
| `.git` | 2.7 MB | — |
| `services/embedding-core/models/` | **1.4 GB** | 否（gitignore） |
| `infra/milvus/volumes/` | 视语料量 | 否 |
| `services/collector-core/.venv/` | 361 MB | 否（gitignore） |
| `services/collector-core/browser_data/` | **1.8 GB** | 否（gitignore，**含登录 Cookie**） |
| `services/collector-core/data/` | 9 MB | 否 |
| `.data/brandsale.sqlite` | 36 MB（当前） | 否 |

> 已逐项用 `git check-ignore` 验证：六个大目录全部被正确忽略，仓库本体只有 2.7 MB。
> 这点做得很干净——**不会把 1.8 GB 的登录态误提交**。

---

## 3. 部署路径（可执行）

### 3.1 与代码一致的初始化序列

```bash
npm install                 # 一次性（需拉 devDependencies，见 §6 缺口 1）
npm run migrate             # 建表
npm run seed                # 登记内置数据源与演示租户
npm run web:build           # 构建控制台 → apps/web/dist（不构建则回退引导页）
npm start                   # 启动网关（8787）

# 以下两项按需
npm run collector:setup     # 仅平台采集：建 Python venv + 装依赖 +（可选）chromium
npm run collector           # 仅平台采集：启动 sidecar（8890）
npm run stack:up            # 仅语义检索：启 Milvus + 嵌入服务
```

### 3.2 生产环境的关键差异

1. **`BM_ENV=prod`**：会关掉 dev 的隐式灌种子（`main.ts` 只在 `env === "dev"` 时 `seedIfEmpty()`），改为"不做任何隐式写库"。
2. **工作目录必须对**：`.env` 是**按 `cwd` 解析**的（`packages/config/src/index.ts:509` `resolve(cwd, ".env")`）。
   用 systemd / 容器时要显式设 `WorkingDirectory` / `WORKDIR`，否则配置全部落空。
3. **可以直接用环境变量注入，不依赖 `.env` 文件**：优先级是 `process.env` **高于** `.env`（`index.ts:512`）。
   这对密钥管理友好——生产可以把 API Key 走容器 secret / 环境注入，`.env` 只留本地开发。
4. **prod 下的硬约束**（`assertConfigInvariants`，`packages/config/src/index.ts:646`）：
   `BM_GATE_FAIL_CLOSED` 必须为 `true`，否则视为配置问题。

### 3.3 推荐的落地形态

```
Internet
   │ 443 TLS
   ▼
nginx / caddy  ──反代──►  127.0.0.1:8787  apps/gateway（systemd unit，WorkingDirectory=仓库根）
                                │
                                ├─ Docker: embedding-core  127.0.0.1:8899
                                ├─ Docker: Milvus          127.0.0.1:19530
                                └─ 127.0.0.1:8890  apps/collector（systemd unit，仅采集需要）
```

- **反代是必需的，不是可选**：gateway 用 `server.listen(port)` **不带 host**，Node 语义是监听 `0.0.0.0`——
  即**默认对全网卡开放**，且协议是明文 HTTP。必须靠反代 + 防火墙收敛。
- embedding-core 与 Milvus 的 compose **已经只绑 127.0.0.1**，这两个不用额外处理（作者有意为之）。

---

## 4. 数据来源面（决定了部署的"外联复杂度"）

外部数据只有两条链路，都不涉及第三方订阅：

| 链路 | 形态 | 部署影响 |
|---|---|---|
| **本地浏览器采集** | MediaCrawler 内核内嵌在本仓库，Python 子进程驱动真实浏览器 | 需要图形环境（见 §5 R1）+ Python 运行时 |
| **联网搜索** | 火山引擎「联网搜索 Lite」，纯 HTTPS 出网 | 无额外进程，配 Key 即用 |

未接入：平台官方 API、第三方数据服务商 API、数据 SaaS 订阅——**均不在方案内**，
因此部署时**不存在"申请第三方账号"这一步**。

---

## 5. 六条硬约束与风险（本评估的核心）

### R1 · 采集链路需要图形界面才能首次登录 ⚠️ 最关键

**事实**：`.env.example` 里 `BM_MC_HEADLESS=false`，注释写明"本机**扫码登录需要可见窗口**"；
内核 `config/base_config.py` 同时 `ENABLE_CDP_MODE=True` + `CDP_CONNECT_EXISTING=True`；
登录方式 `LOGIN_TYPE = "qrcode" | phone | cookie`。

**问题**：一台无图形界面的 Linux 服务器上，扫码窗口**没有地方显示**。

**三种解法**（按推荐度）：

| 解法 | 做法 | 代价 |
|---|---|---|
| ① 本地扫码 + 迁移登录态 | 在本地机器扫一次码，把 `services/collector-core/browser_data/cdp_<平台>_user_data_dir` 同步到服务器，服务器侧走 `LOGIN_TYPE=cookie` / 复用 profile | 最实用；但登录态会过期，且 **1.8 GB 的 cookie 目录成为部署资产**（含隐私，需加密传输与权限收敛） |
| ② Xvfb + VNC 远程扫码 | 服务器起虚拟显示 + VNC，首次人工扫码 | 一次性；后续仍需可用 cookie |
| ③ 服务器装真浏览器 + 有头运行 | 需 X11/桌面环境 | 镜像重、运维成本高 |

**额外的固有脆弱性**（与部署无关但必须知道）：各平台 `login.py` 的选择器是 **DOM 硬编码**，
平台改版即失效，且**除贴吧外的六个平台仍是上游原样**（`architecture.md` §14）。

> **建议**：把"采集"当成**可选的、半人工的运维动作**，而不是无人工厂。
> 报告主链路（联网搜索 + KB 检索 + 模型推理）完全不需要它。

### R2 · MediaCrawler 的非商用许可 ⚠️ 商业交付的法律红线

`NON-COMMERCIAL LEARNING LICENSE 1.1`，条件第 3 条禁止未经版权方书面同意的商业用途。
代码已把它固化成**三道门**（`BM_MC_ENABLED` + `BM_MC_LICENSE_ACK` + `BM_MC_COLLECTOR_URL`），
未确认时七个适配器与七个工具**整体不注册**。

**部署决策点**：这不是技术问题，是**上线前必须由业务/法务拍板**的问题。
`BM_MC_LICENSE_ACK=true` 应当是一个有记录的商务决定，而不是部署脚本里顺手写的一行配置。

### R3 · 没有真实鉴权 ⚠️ 公网部署的阻断项

**事实**（`apps/gateway/src/server.ts:52-66`）：token 形如 `t.<tenantId>.<userId>`，
网关只做**格式校验**后直接构造 `TenantContext`——

```ts
const m = /^Bearer\s+(.+)$/.exec(auth);
const parts = m[1].split(".");
// tenantId: parts[1]
```

**没有密码、没有签名校验、没有会话、没有过期**。后果：

- 任何能访问 8787 的人，**自己拼一个 token 就能读任意租户的数据**（tenantId 是自选的）；
- 控制台页面本身"公开可访问"，靠页内 API 带 Bearer（页面无鉴权）。

**这是当前从"内网能用"到"公网可交付"之间最大的一道坎**。
最小补法：反代层加一层认证（Basic Auth / OAuth2 Proxy / 网关前置），或改造成签发式 token。
但**只要是多客户对外服务，就必须做真正的用户体系**——当前的 `t.tenant_demo.u_demo` 是演示件。

### R4 · 默认监听全网卡 + 无 TLS

`server.listen(config.httpPort, cb)` 未传 host → `0.0.0.0`。
必须：① 反代前置 TLS；② 防火墙只放行 443；③ 采集/嵌入/Milvus 三个端口（8890 / 8899 / 19530）**保持回环**，
不要图省事改绑 `0.0.0.0`——embedding 与 Milvus **都没有鉴权**，等于把客户语料的语义指纹挂在网上
（`docker-compose.yml` 注释里作者已明确点出）。

### R5 · 优雅关闭对 SSE 无效 ⚠️ 会卡住部署与重启

`main.ts` 的 `shutdown()` 用 `server.close()` 等待连接释放；但控制台的 **SSE 长连接永不结束**，
回调不返回 → 进程半死、端口仍占。

**部署影响**：systemd 的 `systemctl restart` 默认会先 SIGTERM，会**卡在停止阶段**直到超时。

**对策**：

```ini
[Service]
TimeoutStopSec=10
KillMode=control-group
KillSignal=SIGKILL      # 或保留 SIGTERM + FinalKillSignal=SIGKILL
```

`architecture.md` §14 已给出同样结论："部署脚本应使用 `kill -9` 或超时兜底"。
另外注意：**重启后未完成的任务不会自动续跑**——`recover()` 只在
`POST /api/v1/jobs/recover`（`server.ts:452`）被显式调用时才执行，启动时没有自动恢复钩子。

### R6 · 只能单实例（架构性约束）

- **SQLite 是唯一真相源**（`.data/brandsale.sqlite`，WAL），`node:sqlite` 是**进程内同步**访问；
- **编排器在网关进程内**（没有独立编排服务/队列），任务状态机跑在本地事件循环里。

推论：
- ❌ 不能多副本、不能水平扩展、**不能滚动更新**（更新 = 停服窗口）；
- ⚠️ 备份不能直接 `cp` 正在写的库：要 `sqlite3 .backup` 或先停写（WAL 有 `-shm`/`-wal`）；
- ✅ 好处是**运维面极小**：一个文件 = 全部状态，迁移 = 拷文件。

多租户能力在应用层已实现（17 张表、租户过滤下推），但它服务的是**多个租户共用一个实例**，
不是"一个租户一个实例"的水平扩展。

---

## 6. 与典型生产化的差距清单

| # | 缺口 | 影响 | 最小补法 |
|---|---|---|---|
| 1 | **后端没有构建产物**，`npm start` 靠 `tsx` 直跑 TS，`tsx` 在 devDependencies | 生产机必须装 dev 依赖 + 保留完整源码 | 镜像里 `npm ci`（含 dev）；或后续加 `tsc` 构建产物 |
| 2 | **没有 gateway 的 Dockerfile**（只有 embedding-core 的） | 无法一条 `docker compose up` 起全栈 | 自写 Dockerfile（Node + Python + 可选 Chrome = **镜像会比较大**） |
| 3 | **没有 systemd unit / PM2 配置** | 缺进程守护、开机自启 | 自备两个 unit（gateway / collector） |
| 4 | **无 TCC / 反代 / 证书** | 公网不可用 | nginx 或 caddy |
| 5 | **无真实用户体系** | 见 R3 | 反代认证（临时）或改造签发式 token（正式） |
| 6 | **密钥明文在 `.env`** | 密钥泄露面 | 用环境注入（`process.env` 优先级更高）+ 容器 secret |
| 7 | **日志是 stdout**（`BM_LOG_LEVEL`） | 无集中收集/轮转 | journald 或 Docker 日志轮转（Milvus 那份 compose 已示范 `x-logging`） |
| 8 | **无指标/追踪后端**（`BM_OTEL_ENDPOINT` / `BM_LANGFUSE_URL` 默认空） | 线上排障只能靠日志 | 按需接 OTEL |
| 9 | **备份策略缺失** | 数据丢失风险 | 定时 `sqlite3 .backup` + 异地拷贝 |
| 10 | **升级流程未定义** | 前后端同源，容易只更新一半 | README 已提供构建时间自证（`index.html` mtime 写进健康检查） |

---

## 7. 最小生产化 Checklist

**任何部署都要做**

- [ ] Node >= 22.19；`WorkingDirectory` 设为仓库根（`.env` 按 cwd 解析）
- [ ] `BM_ENV=prod` + `BM_GATE_FAIL_CLOSED=true`
- [ ] `npm run migrate`（**不要**在生产依赖 dev 的自动灌种子）
- [ ] `npm run web:build`，确认网关托管的是 `apps/web/dist`
- [ ] 反代 + TLS；防火墙只放行 443（8787 不外露）
- [ ] systemd unit 配 `KillSignal=SIGKILL` / 短 `TimeoutStopSec`（R5）
- [ ] 定时备份 `.data/brandsale.sqlite`（用 `.backup`，别 `cp`）
- [ ] 密钥走环境注入，`.env` 不入库不进镜像

**要用平台采集才做**

- [ ] 决定 R2：`BM_MC_LICENSE_ACK` 是否有版权方书面同意（**商务决策，留痕**）
- [ ] 决定 R1：登录态怎么进服务器（推荐"本地扫码 + 同步 profile"）
- [ ] 装 Python >= 3.11 +（Chrome 或 chromium）；`npm run collector:setup`
- [ ] 确认 collector 只绑 127.0.0.1（`BM_COLLECTOR_HOST` 默认值即是）
- [ ] 给 1.8 GB 的 `browser_data/` 定好权限与备份策略（**含登录 Cookie**）

**要用语义检索才做**

- [ ] `npm run stack:up`（embedding + Milvus），确认内存余量（各限 3g）
- [ ] 首次给存量语料补算向量：`npm run embedding:backfill`
- [ ] 确认 `BM_EMBED_URL` 与 `BM_VECTOR_DRIVER` 一致——二者不匹配时语义通道会**静默关闭**（§14 已列）

---

## 8. 总结

**能部署，且不需要改造架构。** 这是一个刻意的"单机、单进程、文件即状态"设计，
运维面比同类系统小得多：一个 Node 进程 + 一个 SQLite 文件就是全部必需，
其余（Python 采集、Docker 双件）都是**可缺席的增强项**，缺席时按能力显式降级。

真正需要在上线前拍板的是**三条非技术性/边界性的事**：

1. **采集的登录态怎么进服务器**（R1）——做成半人工运维动作，还是干脆先不上采集；
2. **非商用许可要不要认**（R2）——这是法务/商务签字的事，不是配置项；
3. **谁来管鉴权**（R3/R4）——内网随便用；一旦对公网、对多客户，当前的 token 方案必须换掉。

除此之外，只要接受 **"单实例 + 有停服窗口"** 这个前提，现有实现直接就能在服务器上跑起来。
