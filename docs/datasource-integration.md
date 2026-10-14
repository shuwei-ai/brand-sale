# 外部数据源接入现状

> 本文描述**当前代码里真实存在**的外部数据源接入面。
> 相关代码：`packages/datasource/src/{index,web-search,media-crawler}.ts`、
> `apps/collector/`、`services/collector-core/`（内嵌采集内核）、
> `packages/config/src/index.ts`、`packages/agent-pack/src/tool-impls.ts`、
> `scripts/{seed,datasource-smoke}.ts`
>
> 平台采集的选型与许可评估见
> [`datasource-platform-collection-analysis.md`](./datasource-platform-collection-analysis.md)。

---

## 0. 一句话现状

| 源 | 台账 ID | 真实链路 | 说明 |
|---|---|---|---|
| 联网搜索 | `volc_web_search` | ✅ 实测连通 | 火山引擎联网搜索 Lite，抓公开网页 |
| 小红书公开内容 | `mc_xhs` | ⏳ 需本机采集 | MediaCrawler，经 collector sidecar |
| 抖音公开内容 | `mc_dy` | ⏳ 需本机采集 | 同上 |
| 快手公开内容 | `mc_ks` | ⏳ 需本机采集 | 同上 |
| B站公开内容 | `mc_bili` | ⏳ 需本机采集 | 同上 |
| 微博公开内容 | `mc_wb` | ⏳ 需本机采集 | 同上 |
| 贴吧公开内容 | `mc_tieba` | ⏳ 需本机采集 | 同上 |
| 知乎公开内容 | `mc_zhihu` | ⏳ 需本机采集 | 同上 |

工具总数：**17 个**（10 个基础工具 + 7 个平台内容工具）。

**装配是分层的**，三个层次互相独立：

| 层次 | 何时生效 | 未生效时的表现 |
|---|---|---|
| 台账登记（`sources` 表） | 始终（`npm run seed`） | — |
| 适配器装配（M4 注册表） | 三个开关齐备才装配 | 工具缺席；`resolve_authorization` 把它们列进 `capabilityMissing` |
| 工具注册（M10） | 适配器在则注册 | Agent 工具清单里没有该工具 |

"登记了但没装配"是**正常状态**，不是 bug：台账登记是合规动作，能力装配是运维动作。

---

## 1. 为什么中间要有一个 collector sidecar

采集内核（MediaCrawler）是**浏览器驱动的长任务**，不是查询接口：

```
python services/collector-core/run.py --platform xhs --type search --keywords ...
   →  Playwright 起浏览器（首次扫码登录）→ 采集（几十秒～几分钟，单会话串行）
   →  结果落到 services/collector-core/data/{平台}/{type}_{item}_{date}.jsonl
```

而 brandsale 要的是 `fetch(query) → { rows, provenance }` 的**同步、按查询**语义，
工具层还带 12–15s 超时。两者对不上。所以中间放 `apps/collector`：

```
brandsale 适配器 ──HTTP──▶ collector ──spawn──▶ 内嵌采集内核（services/collector-core）
                             │                        │
                             ├── 归一化 jsonl ◀───────┘ 读内核 data/ 目录
                             └── 本地 JSONL 缓存
```

> **内核已内嵌进本仓库。** 早期版本驱动的是**独立部署**的 MediaCrawler（走它的 FastAPI
> 控制面，需要运维第二个进程与端口）。现在 `services/collector-core/` 就是采集内核本体
> ——七个平台的客户端、扫码登录、签名 JS（`libs/*.js`）全在里面，采集由 collector 以
> **子进程**方式驱动。部署上只有 brandsale 一个系统；代价是它自带一个 Python 运行时
> （`npm run collector:setup` 一次性准备）。内核的来源、许可与裁剪清单见
> [`services/collector-core/README.md`](../services/collector-core/README.md)。

它解耦的是**采**与**查**：

- 采集在后台异步发生一次（缓存为空时自动投递）；
- 查询读本地归一化缓存，毫秒级返回，形状与 `web_search` 一致。

collector 只暴露**四个只读算子**，没有任何转发式代理接口 —— MediaCrawler 自带的
点赞/评论/关注/发帖能力在接口形状上就无从表达。这是刻意的：见 §6。

---

## 2. 三道门：平台采集什么时候才会生效

缺任何一道，七个适配器与七个工具**整体缺席**：

```bash
BM_MC_ENABLED=true        # 1) 总开关
BM_MC_LICENSE_ACK=true    # 2) 许可确认（见 §3，默认 false）
BM_MC_COLLECTOR_URL=...   # 3) collector 地址（且 collector 进程真的在跑）
BM_MC_PLATFORMS=xhs,dy,ks,bili,wb,tieba,zhihu   # 4) 逐平台开关，默认全开
BM_MC_PREFETCH_SCOPE=brief                      # 5) 预取范围：brief（默认，只采 brief 声明的平台）/ all
```

第二条刻意做成"必须显式做一次决定"：MediaCrawler 是非商用许可，
不该因为顺手配了个地址就悄悄进入商业交付链路。

启动自检（`assertConfigInvariants`）会把缺哪道门明确打出来。

---

## 3. 许可证红线（务必先读）

MediaCrawler 的许可证是 `NON-COMMERCIAL LEARNING LICENSE 1.1`，条件第 3 条原文：

> 未经版权所有者书面同意，不得将本软件用于**任何商业用途**或对第三方造成不当影响。

第 2 条还把用途限定在「学习和研究目的」。brandsale 是商业交付系统，报告直接指导
甲方真实投放预算，因此这条链路**只有在产品或法务已明确评估并接受该风险的前提下
才允许打开**。处置方案（含申请函模板与工程加固清单）见
[license-compliance-mediacrawler.md](./license-compliance-mediacrawler.md)。

`BM_MC_LICENSE_ACK` 就是把这个决定固化下来的开关。它不影响台账登记（七源照常登记、
可被 `resolve_authorization` 看到），只影响**能力装配**。

同时遵守许可证第 2 条「不得大规模爬取 / 不得干扰平台运营」：collector 单次采集条数
默认 50、硬上限 200（`BM_MC_MAX_ITEMS_CAP`），且 MediaCrawler 自身单进程串行。

---

## 4. 七平台能力表

各平台的算子**统一为四个**，因为 MediaCrawler 对七个平台都只实现了
`search` / `detail` / `creator` 三种 `crawler_type`（已核对各平台 `core.py`）：

| 算子 | 参数 | 对应 `crawler_type` | 产出 |
|---|---|---|---|
| `search` | `keyword` | `search` | 内容列表 |
| `content_detail` | `contentId` 或 `url` | `detail` | 单条内容详情 |
| `comments` | `contentId` 或 `url` | `detail` + `enable_comments` | 内容评论（可选二级） |
| `creator` | `creatorId` | `creator` | **该创作者的公开作品**（不含创作者资料页） |

| 平台 | 源 ID | 工具名（**对模型隐藏**） | 内容 | 创作者 |
|---|---|---|---|---|
| 小红书 | `mc_xhs` | `xhs_web` | 笔记 | 博主 |
| 抖音 | `mc_dy` | `douyin_web` | 视频 | 达人 |
| 快手 | `mc_ks` | `kuaishou_web` | 视频 | 博主 |
| B站 | `mc_bili` | `bilibili_web` | 视频 | UP 主 |
| 微博 | `mc_wb` | `weibo_web` | 微博 | 博主 |
| 贴吧 | `mc_tieba` | `tieba_web` | 帖子 | 用户 |
| 知乎 | `mc_zhihu` | `zhihu_web` | 回答 | 答主 |

**⚠️ 模型看到的只有一个入口：`platform_digest`（跨平台聚合）。** 上表那七个工具仍然注册、
仍各绑各的 `mc_*` 源、仍逐个过闸门，但标记了 `policy.hidden`，**不出现在模型的工具清单与提示词里**。
原因：七个同形工具并列时，模型既容易选错，也几乎必然在上下文里手工合并跨平台结果 ——
而"哪些指标可比"恰恰是 LLM 做不准的部分（拿 B站播放量去比小红书就是这么来的）。
`platform_digest` 把三件事固定成确定性步骤：逐源过闸门（未通过的平台跳过并记名）、
合并打平台标签、以及算出 `comparison.metrics`（本组平台指标的**交集**，跨平台对比只允许落在这上面）。
详见 `docs/platform-capability-integration-plan.md` §3 P1′ 与 §4 真机复验。

**⚠️ B站 的粉丝 / 关注列表拿不到**：客户端里确有 `get_creator_fans` /
`get_creator_followings`，但 `media_platform/bilibili/core.py` 里对应调用是**注释掉的**，
CLI 与 FastAPI 都没有开关触发它。走现有黑盒入口拿不到，所以**没有**把它写成算子 ——
把不可达的能力写进工具描述，只会让模型反复去调一个必然空手的算子。

**⚠️ `creator` 算子不返回创作者资料页（七平台全缺粉丝数）**：`creator` 的产出主体是
**该创作者的公开作品**（落到 `kind=content`）。创作者资料页——粉丝数 / 简介 / 性别 / 地域 / 头像——
**七个平台一个都拿不到**，这是上游「教学版」为防骚扰刻意移除的：
`store/{xhs,dy,ks,wb,tieba}/__init__.py:save_creator` 全部 `return` 空操作，
`store/zhihu/_store_impl.py:store_creator` 是 `pass` 且 `media_platform/zhihu/core.py` 从不调用它
（B站同理，core 不调用），实测落盘目录里**没有任何 `creators_*.jsonl`**。
所以别把 `creator` 当作"拉主页资料"的能力。

七平台在**内容层**（搜索/详情/评论/创作者作品）全部可用，但各平台指标并不一致
（快手内容无评论数、贴吧内容无点赞、只有 B站给播放/弹幕/投币），跨平台对比只能用共有指标；
**粉丝画像**（年龄/性别/地域）公开 Web 接口层一个平台都没有，仍需 L1 官方通道（见 §7）。
逐能力的完整矩阵与智能体集成方案见 `docs/platform-capability-integration-plan.md`。

---

## 5. 配置清单

```bash
# ── 联网检索 ──────────────────────────────────────────────
BM_WEB_SEARCH_ENABLED=true
BM_WEB_SEARCH_URL=https://open.feedcoopapi.com/search_api/web_search
BM_WEB_SEARCH_API_KEY=            # 空 = 能力缺席
BM_WEB_SEARCH_COUNT=20
BM_WEB_SEARCH_MAX_COUNT=50
BM_WEB_SEARCH_TIMEOUT_MS=8000
BM_WEB_SEARCH_CACHE_TTL=900       # 相同查询缓存 15 分钟
BM_WEB_SEARCH_PREFETCH=true

# ── 平台采集：brandsale 侧 ────────────────────────────────
BM_MC_ENABLED=false               # 总开关
BM_MC_LICENSE_ACK=false           # 许可确认（见 §3）
BM_MC_COLLECTOR_URL=http://127.0.0.1:8890
BM_MC_PLATFORMS=xhs,dy,ks,bili,wb,tieba,zhihu
BM_MC_PREFETCH_SCOPE=brief        # 自动预取覆盖哪些平台（brief / all）
BM_MC_TIMEOUT_MS=15000
BM_MC_CACHE_TTL=1800

# ── 平台采集：collector 侧 ────────────────────────────────
BM_MC_CORE_DIR=services/collector-core   # 内嵌内核目录（留空 = 默认值）
BM_MC_PYTHON=                            # 留空 = <coreDir>/.venv/bin/python → PATH 的 python3
BM_MC_DATA_DIR=                          # 采集落盘目录（留空 = <coreDir>/data）
BM_MC_LOG_DIR=./.data-collector/logs     # 每次采集一个 <taskId>.log（排障看子进程原始输出）
BM_COLLECTOR_DATA=./.data-collector      # 归一化缓存
BM_COLLECTOR_HOST=127.0.0.1
BM_COLLECTOR_PORT=8890
BM_MC_HEADLESS=false                     # 扫码登录需要可见窗口
BM_MC_MAX_ITEMS=50
BM_MC_MAX_ITEMS_CAP=200
BM_MC_CRAWL_TIMEOUT_MS=600000            # 首次含扫码，给足 10 分钟
BM_MC_ENV_CHECK_TIMEOUT_MS=60000
```

**空结果不进缓存**：`withCache` 只缓存有内容的响应。否则"首次调用排队采集 →
稍后重试"这条自愈路径会被自己的空缓存堵死（有用例钉着）。

---

## 6. 运行手册（内嵌内核 + 本机扫码登录）

```bash
# ① 一次性：准备内核的 Python 环境（建 venv + 装依赖 + 下载 chromium，约几分钟）
npm run collector:setup

# ② 起 collector sidecar（在 brandsale 根目录）
npm run collector

# ③ 自检
curl -s http://127.0.0.1:8890/health | jq
#    core.installed=true、core.python 指向 <coreDir>/.venv 即可继续
curl -s http://127.0.0.1:8890/env-check | jq     # 真跑一次内核自检（import 全部平台依赖）
curl -s http://127.0.0.1:8890/platforms | jq

# ④ 手动采一次（可选；brandsale 首次调用工具时也会自动排队）
#    首次会弹出浏览器窗口，**扫码登录**；登录态持久化在 <coreDir>/<平台>_user_data_dir/，之后复用
curl -s -X POST http://127.0.0.1:8890/collect -H 'Content-Type: application/json' \
  -d '{"platform":"xhs","op":"search","params":{"keyword":"精华"},"maxItems":20}' | jq
curl -s http://127.0.0.1:8890/tasks | jq
#    采集失败时看子进程原始日志（扫码、风控、缺依赖都在这里）
curl -s http://127.0.0.1:8890/tasks/<taskId>/log

# ⑤ 查缓存
curl -s -X POST http://127.0.0.1:8890/query -H 'Content-Type: application/json' \
  -d '{"platform":"xhs","op":"search","keyword":"精华","limit":5}' | jq

# ⑥ 打开 brandsale 侧的三道门（.env），重启主程序
#    BM_MC_ENABLED=true / BM_MC_LICENSE_ACK=true / BM_MC_COLLECTOR_URL=...
npm run datasource:smoke            # 逐源联通性自检
npm run datasource:smoke -- --mc-keyword='精华'
```

采集是**分钟级**的，所以工具是"投递 + 稍后重试"的模型：首次调用返回 0 条并已在后台
排队，第二次调用就能拿到数据（空结果不缓存保证了这一点）。

`npm run datasource:smoke` 对每个**已配置**的源真发一次请求，打印行数、耗时、`tier`、
`synthetic`、口径与样例。未配置的源只提示、不算失败。退出码：全通 0 / 有源不通 1。
它绕过闸门（直接拿适配器）——这是运维诊断工具，不是业务调用，产出的数字不得进入报告。

---

## 7. 合规边界

1. **L3 不得被当 L1 用**。公开网页与平台公开内容只能支撑关于**他人**的公开断言
   （"某媒体报道称该类目大盘增长 X%"、"某达人近 30 条笔记平均点赞 1.2 万"），
   **不得**支撑关于甲方自身的断言（"我们店铺 ROI"、"我们的粉丝画像"）。
   `provenance.note` 一律写明"未经人工核验 + 与平台无授权合同"。
2. **L3 源禁止填 `contractRef`**。`contractRef` 语义是"授权合同"，公开采集没有合同，
   填了就是把"公开采集"洗成"已授权实测"，`assertSourceRegistration()` 从写入口抛 `E-GOV-005`。
3. **只读，不封装任何写能力**。collector 只暴露四个只读算子，不做转发式代理；
   工具侧 `mutating=false`，白名单只给 CI/CT。
   `ToolPolicy.mutating` 默认关闭，装配期还强制 mutating 工具挂 `authz` 且 `replaySafe=false`。
4. **不接"星图出租 / 品牌过审代办"**。这类服务违反平台条款、有封号风险、
   来源合法性无法证明——走这条路报告里的 `sourceDeclaration` 就是假的。

---

## 8. 来源目录口径：登记 ≠ 可引用

`buildSourceCatalog` 现在接受 `availableSourceIds`（已装配的适配器 ID），台账源必须
同时满足 **有生效授权 + 非 L4 未批 + 适配器已装配** 才进目录。

原因：七个平台源会**先登记**（合规动作），但适配器要过许可闸才装配（运维动作）。
若不在这里过滤，报告会在来源声明里列出一个"已授权但根本取不到数据"的源 ——
正是早先"残留登记记录导致可用源列表虚高"那类问题的翻版。

对应地，`resolve_authorization` 现在返回三组：

- `usableSources` —— 授权 + 法务 + 能力都就绪，**真正可用**；
- `blockedSources` —— 缺授权 / L4 未过法务，原因把**所有**未通过的门列全；
- `capabilityMissing` —— 已授权但采集能力未装配（缺的是开关，不是授权）。

分开列是有意的：这两类"缺什么"完全不同，混在一起读者会按"去补授权"处理，白费功夫。

---

## 9. 需要平台内数据时的正确做法

按缺口分级，**先商务后代码**：

| 需要的字段 | 通道 | 门槛 |
|---|---|---|
| 粉丝画像（年龄/性别/地域/兴趣） | 抖音开放平台 `fans_data` | L1：企业主体 + 「关系数据」权限审核（约 2–3 工作日）+ 达人选 OAuth 授权 |
| 达人报价 / 商单转化 | 星图 / 蒲公英 或第三方数据服务 | L2 / L4：有合同、需法务审批（`legal_approved` 双开关） |
| 公开内容层（内容 / 评论 / 创作者） | 本项目的七个平台采集源（L3） | 已接入，见 §2 / §6 |

**共同前提**：新增真实适配器时走完整的 **登记 → 授权 → 闸门** 流程
（在 `scripts/seed.ts` 的 `BUILTIN_SOURCES` 加条目），而不是让模型去公开网页里
「调研」自己店铺的 ROI。
