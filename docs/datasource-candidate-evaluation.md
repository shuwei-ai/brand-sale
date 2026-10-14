# 数据源候选评估：DTK / xiaohongshu-cli

> **⚠️ 状态（2026-10-09）：两个候选均未采纳，本文为历史评估记录。**
> 基于本文的评估，曾接入 `douyin_web_public`（DTK）与 `xhs_web_public`（xhs 只读代理）
> 两条适配器；随后于 2026-10-09 **整体移除**，理由与替代路径见
> [`datasource-platform-collection-analysis.md`](./datasource-platform-collection-analysis.md)。
> 本文对「两者都补不了 P0-3 粉丝画像」的判断仍然成立，并已被七平台评估再次验证。

> 评估日期：2026-10-08 · 评估对象：
> - `Evil0ctal/Douyin_TikTok_Download_API`（下称 **DTK**）
> - `jackwener/xiaohongshu-cli`（下称 **xhs**）
>
> 背景：`docs/requirements-coverage-analysis.md` 认定需求「抖音明星粉丝画像 / 粉丝占比 / 年龄层分布」
> 为 P0-3 缺口。本文判断这两个开源项目能否为该缺口提供数据支撑。

---

## 0. 结论

一句话：**两个项目都是「公开内容采集器」，补的是达人 / 内容层，都补不了 P0-3。**
受众聚合画像（年龄 / 性别 / 地域占比）在抖音与小红书的**公开 Web 接口里根本不存在**——
这不是解析能力问题，是接口层没有这个数据。

| 需求缺口 | DTK | xhs | 说明 |
|---|:---:|:---:|---|
| **P0-3 抖音明星粉丝画像 / 占比 / 年龄层** | ❌ | ❌ | 接口层不存在，非解析问题 |
| P1 达人维度（粉丝量 / 作品量 / 互动率 / 内容风格） | ✅ 强 | ✅ 中 | 本评估的主要价值点 |
| 竞品内容矩阵（发什么、什么题材、什么节奏） | ✅ 强 | ✅ 中 | 历史作品全量 + 时间轴 + 逐条指标 |
| 舆情 / 评论区口碑（内容合规 + 塌房预警的输入） | ✅ 强 | ✅ 中 | 一级评论 + 二级回复 |
| 热榜 / 趋势 | ⚠️ 常量已定义**未接线** | ✅ `hot` 命令 | DTK 搜索类端点也不在 P0 注册表内 |
| P1 艺人（明星）维度 | ⚠️ 只有作者实体 | ❌ | 无职业 / 经纪 / 代言记录，非「艺人库」 |
| P1 投流与增量建议 | ❌ | ❌ | 广告投放后台数据，公开接口没有 |
| **小红书侧数据** | ❌ | ✅ 唯一来源 | `POPULAR_PLATFORMS` 已含 `xiaohongshu`，当前**零真实数据** |
| P1 RAG 入库通道 | ✅ 可用 | ✅ 可用 | 批量内容可落库，是真正的顺手收益 |

**一句话版本**：DTK 能补「抖音达人 + 内容 + 评论」，xhs 能补「小红书」这一整格；
两者都**不能**补「粉丝画像」，也**不能**补「投流」。

---

## 1. 两个项目的事实

### 1.1 DTK — Douyin_TikTok_Download_API

| 项 | 值 |
|---|---|
| Star / Fork | 20,505 / 2,845 |
| 许可 | Apache-2.0（含 `LICENSE` + `NOTICE`），允许商用与闭源分发 |
| 活跃度 | 最近提交 **2026-10-02**（评估日 6 天前），未归档 |
| 技术栈 | Python 3.12 · FastAPI · SQLAlchemy 2.0 async · Alembic · PostgreSQL + TimescaleDB · Redis |
| 交付形态 | Docker Compose 自托管；Web 控制台 + REST（93 个操作）+ **MCP**（streamable-http）+ CLI |
| 签名 | 纯 Python 实现 a_bogus / X-Bogus / X-Gnarly / X-Dynosaur |
| 传输 | `wreq`（浏览器 TLS 指纹仿真）+ httpx；身份池 + 代理池 + 令牌桶 + 熔断器 |
| 认证 | 导入自身登录 Cookie，身份池自愈 |

**实际接线的端点只有 10 个**（`src/dtk/platforms/douyin/endpoints.py` 的 `ENDPOINTS` 注册表）：

```
SESSION_CHECK · CONTENT_DETAIL · AUTHOR_PROFILE · AUTHOR_POSTS · AUTHOR_LIKES
AUTHOR_COLLECTIONS · COLLECTION_POSTS · MIX_POSTS · COMMENTS · COMMENT_REPLIES
```

搜索与热榜的 URL 常量（`GENERAL_SEARCH` / `VIDEO_SEARCH` / `USER_SEARCH` /
`LIVE_SEARCH` / `DOUYIN_HOT_SEARCH`）**在类里定义了，但没有进注册表**，
按其官方文档属于 P0 范围之外。**所以：没有关键词搜索、没有热榜、没有直播数据。**

抖音的**关注 / 粉丝列表明确不支持**（README 表格标 ❌）：该列表只发给已登录会话，
作者选择不注册「永远返回空页」的端点——这个取舍本身说明项目对"返回空数据"是有洁癖的。

归一化数据模型（`src/dtk/models/content.py`，跨平台统一契约）：

```
Author : platform · uid(=sec_uid) · sec_uid · unique_id · nickname · signature
         · avatar · web_url · verified · stats{ follower_count, following_count,
         content_count, total_digg } · raw
Content: platform · content_id · kind · web_url · title · description · created_at
         · duration_ms · is_deleted · is_private · author · stats{ play_count,
         digg_count, comment_count, share_count, collect_count } · media · music
```

**关键证据**：`parser.py` 的 `_author_from_node()` 只取
`follower_count / following_count / aweme_count / total_favorited / sec_uid /
unique_id / nickname / signature`——**不取 `gender`、不取 `city`**。
抖音作者主页的原始 payload 里其实有这两个字段，归一化时被**有意丢弃**，
只保留在 `raw`（文档里写明"保留原始 payload 以便日后回算新指标"）。

这恰好证明了它的视角：**它回答的是「这个账号是谁」，不是「这个账号的粉丝是谁」。**

作者自己在 README 里写明责任边界：

> This fetches data from platforms that have their own terms, and it runs on your machine
> under your control. Respect those terms and applicable law... Nobody else can enforce
> any of that for you.

### 1.2 xhs — xiaohongshu-cli

| 项 | 值 |
|---|---|
| Star / Fork | 2,657 / 277 |
| 许可 | README 标称 Apache-2.0，但**仓库根目录没有 LICENSE 文件**（GitHub 识别为 `license: null`） |
| 活跃度 | 最近提交 **2026-03-21** → 约 **6.5 个月未更新**（对比 DTK 的 6 天） |
| 技术栈 | Python（Typer/Click）；自带 `SKILL.md`（面向 AI Agent）+ 结构化 envelope |
| 输出契约 | `{ ok, schema_version, data }` / `{ ok, error:{code,message} }`，支持 `--json` / `--yaml` |
| 认证 | `browser_cookie3` 自动提取浏览器 Cookie（**7 天 TTL**）+ 二维码登录 |

能力清单（`xhs_cli/commands/` 按模块分文件）：

| 模块 | 命令 | 读/写 |
|---|---|---|
| `reading.py` | `search`(笔记/用户/话题) · `read` · `comments` · `user` · `user-posts` · `feed` · `hot` | 读 |
| `interactions.py` | `like` · `favorite` · `comment` · `reply` · `delete-comment` | **写** |
| `social.py` | `follow` · `unfollow` · `favorites` | **写** |
| `creator.py` | `post`(发图文笔记) · `my-notes` · `delete` | **写** |
| `notifications.py` | `unread` · `notifications` | 读 |

**反风控**（README 自述）：固定 macOS Chrome 指纹、`sec-ch-ua` 对齐、session 级浏览器身份持久化、
高斯抖动延迟、验证码冷却、指数退避。README 直接列出这些失败态：
`not_authenticated` / `verification_required` / `ip_blocked` / `signature_error`。

payload 里确实有 `gender` / `ip_location` / `fans`(= `fans_total`) / `red_id` / `desc`，
但追到 `formatter_normalizers.py` 可见它们来自 `basic_info`——
**是账号自身的属性，不是粉丝聚合画像**。

仓库内代码检索：`画像` / `年龄` / `audience` / `demographic` → **全部 0 命中**。

---

## 2. 为什么 P0-3 一定填不上

需求原文（§关键外部数据）说得比缺口描述更清楚：

> 抖音的明星粉丝画像、粉丝占比、年龄层分布等。目前靠人工向艺人索要，效率很低；
> **可考虑通过数据公司开放平台／开发者接口采买。**

**「粉丝画像」是受众聚合统计**，属于「人群层」。它在数据链条上的来源只有三处：

| 来源 | 门槛 | 对应 tier |
|---|---|---|
| 巨量云图 / 星图 | 甲方或服务商**账号登录 + 授权**，按量计费 | L1/L2 授权 |
| 千川投放后台 | **广告主账号** | L1 平台 |
| 艺人 / 机构自己后台导出 | 商务关系（**甲方现在的做法**） | L2 执行 |
| ~~平台公开 Web 接口~~ | **不存在该数据** | — |

这两个项目走的是**游客 / 普通用户视角的公开 Web 接口**，从架构上就拿不到后台的聚合画像。
DTK 主动丢弃作者 `gender` / `city` 是最直接的旁证。

顺带一个反证：如果公开接口真能取到粉丝画像，甲方就不必"人工向艺人索要"了——
这个现状本身就是最硬的证据。

**所以：接入它们能改善 P1，不能改变 P0-3 的判定。**
P0-3 仍然只有三条路，且顺序不能反：

1. 甲方授权提供（含艺人 / 机构导出）
2. 按需求原文：**向数据公司开放平台采买** → 新增真实适配器 + 台账登记 + **L4 双开关** + 法务放行
3. 联网检索降级兜底 → 精度低，必须标 L3 未核验，且**只能做定性描述**

> **后续补充（2026-10-08）**：进一步核实后发现两件重要的事，已在
> [`docs/p0-3-data-supply-evaluation.md`](./p0-3-data-supply-evaluation.md) 中展开：
>
> - **抖音开放平台官方有 `fans_data` 接口**，字段正是需求点名的年龄 / 性别 / 地域分布，
>   **官方免费**，但需要企业资质 + **被查询达人本人 OAuth 授权**——只覆盖已合作艺人。
> - **抖音评论接口返回 `ip_label`（省级属地）**，DTK 保留在 `raw` 里可回算，
>   因此**粉丝地域分布可做「有偏代理」**（该做法已有第三方隐私审计给出 Medium 级风险提示，
>   须按粗粒度聚合 + 如实标注偏差的方式使用）。
>
> 修订后的结论：**③采集 + 检索组合能把 P0-3 从「完全缺失」提升到「地域可代理、年龄性别仍缺」**，
> 是部分满足，不能宣称满足。

---

## 3. 它们真正能补什么

按「价值 > 成本」排序：

**① 小红书侧从 0 到有（xhs 的唯一强价值）**
`packages/contracts/src/common.ts` 里 `POPULAR_PLATFORMS = ["douyin", "xiaohongshu",
"bilibili", "weibo"]`——小红书**已经在契约里声明为受支持平台**，但目前没有任何真实数据源，
Brief 里填了小红书也只能得到模型推断。xhs 是当前唯一能填这一格的候选。

**② 达人维度加厚（DTK 最强项）**
现有 `knowledge.pricing` 的 5 个种子达人只有粉丝量与报价两三个字段。
DTK 能给：作者主页 + 全部历史作品 + 逐条播放/点赞/评论/转发/收藏 + 一级评论 + 二级回复。
这直接支撑三件事：
- 人选匹配从「看粉丝量」升级为「看真实互动率与内容调性契合度」
- 竞品内容矩阵有真实素材（什么时候发、什么题材、什么节奏）
- 评论区文本可作为内容合规审查与舆情预警的输入

**③ 历史归档能力（DTK 独有）**
内容全部落 PostgreSQL + TimescaleDB，带指标快照曲线（counter snapshots）。
作品被上游删除后本地仍在——对「事后复盘某次投放」有实际意义，
也正好补上 KB-2「历史执行与私域知识库」缺素材的问题。

**④ 顺手补 RAG 入库通道**
P1-5 的缺口是「`knowledge.ingest()` 只有 `scripts/seed.ts` 一处调用，HTTP 层没有入库接口」。
这两个工具都能批量产出结构化内容，正好成为入库通道的第一批真实数据来源。

---

## 4. 治理语义：接入后该标哪一级

这是最需要拍板的地方，也是最容易出错的。

brandsale 的设计前提是每个源走 **登记 → 授权 → 闸门**：

- `DataSourceAdapter` 声明 `sourceId / displayName / tier / capabilities`
- `ToolPolicy.boundSourceId` **由代码绑定**，防止模型在参数里自报来源绕过闸门
- 闸门 5 项串行 fail-closed；L4 还需 `legalApproved` 双开关
- 报告侧 R6「携带数字必须有来源」、R8「引用 L4 一律拒绝渲染」

接入这两个项目时，台账里的 `authMethod` / `contractRef` **填不出合法值**——
因为不存在与平台的授权合同。

**建议：标 L3**（公开可用但未人工核验），并在 `sourceDeclaration` 的 `coverage` 里写明口径：

> 公开 Web 接口采集 · 未经平台授权 · 未经人工核验 · 采集时间 {asOf}

**绝不能标 L1 / L2。** 标了就等于把「未经授权采集」洗成「甲方授权实测」——
这与当初删掉 5 个合成适配器要避免的是**同一类错误**。
（那次是「假数据装真数据」，这次会是「未授权装已授权」。）

由此推论出一条使用边界：

| 允许 | 不允许 |
|---|---|
| 「该达人公开粉丝量 380 万、近 30 篇平均点赞 1.2 万」 | 「我们店铺 ROI 1.9」 |
| 「该品类公开可见的内容分布」 | 「我们达人真实带货转化」 |
| 关于**他人**的公开断言 | 关于**甲方自身**的经营断言 |

后者必须等 L1/L2 授权源。

---

## 5. 一个必须先补的架构缺口：`ToolPolicy` 没有「写操作」标记

`packages/contracts/src/agent.ts` 中 `ToolPolicy` 的现有字段：

```
name · allowedAgents · governance · boundSourceId · rateLimit · timeoutMs
· retry · fallback · parallelism · replaySafe · maxCallsPerJob
```

**没有 `mutating` / `sideEffect` 标记。**

现状无所谓——唯一的适配器 `volc_web_search` 是只读的，`replaySafe` 也只是为
checkpoint 重放判断幂等。但 **xhs 自带写能力**（点赞 / 收藏 / 评论 / 回复 / 关注 /
发笔记 / 删笔记）。如果整包封装成一个工具，**当前契约在类型层无法阻止模型去操作
甲方的小红书账号**——那是对外的、不可逆的行为，且完全绕过闸门「只读取数」的隐含假设。

两条做法：

- **(a) 立刻能做的纪律**：只封装**只读子集**（`reading.py` 的
  `search / read / comments / user / user-posts / feed / hot`），把
  `interactions.py` / `social.py` / `creator.py` / `notifications.py` **整体不暴露**。
  这四类正好是按文件分开的，白名单可以落在文件粒度上。
- **(b) 正解**：给 `ToolPolicy` 加 `mutating: boolean`（默认 `false`），
  装配期断言 `mutating === true` 的工具不注册（或要求更高的授权等级）。
  这样以后任何写操作在类型层就进不来，而不是靠这一次的纪律。

**建议 (a) 与 (b) 都做**：(a) 现在，避免本轮引入风险；(b) 随下一次契约变更补上。

---

## 6. 接入形态（若决定接）

按项目既有的六步走（适配器 → 工具 → 闸门绑定 → 台账登记 → 幂等自举 → 离线用例）：

1. 新增 `packages/datasource/src/dtk.ts`、`packages/datasource/src/xhs.ts`
   两个适配器，`synthetic: false`，`capabilities` 用 `platform:metric` 命名
   （如 `douyin:author_profile`、`douyin:content_stats`、`xiaohongshu:note_search`）
2. `scripts/seed.ts` 的 `BUILTIN_SOURCES` 加两条 **L3** 条目
3. 新工具走 `ToolPolicy.boundSourceId` 硬绑定，`allowedAgents` 只给 `CI` / `CT`
4. `maxCallsPerJob` 必须设——DTK 每次调用都是一次上游请求，模型很容易在工具循环里刷爆
5. 补离线用例（不联网），并把 `npm run check:boundaries` 保持在绿

**部署侧的差异（重要）**：

| | DTK | xhs |
|---|---|---|
| 形态 | 自托管常驻服务 | 本地 CLI |
| 依赖 | Docker + PostgreSQL + Redis + 身份池 + 代理 | **操作者本人的浏览器 Cookie** |
| 配置 | 一个 `BM_DTK_BASE_URL` 即可 | 需处理 7 天 Cookie 过期、验证码、IP 封禁 |
| 运维风险 | 中（有控制台、诊断、备份） | **高**——在服务端跑等于把某个人的人工登录态当基础设施 |

**两条硬约束**：`packages/datasource` 只被 M3 之后的调用链使用，适配器不准绕过闸门；
`scripts/check-boundaries.ts` 的白名单矩阵不能动。

---

## 7. 与需求 §2.6 的关系

对 P0-3 的那条待确认问题**是前置**：

> 甲方可提供哪些私域／文档数据？是否接受外采、费用谁承担？

在甲方回答之前，接入这两个项目**不改变**「P0-3 未覆盖」这个结论，
只会把 P1 的达人 / 内容 / 舆情三项从「缺失」提到「部分满足」。

而需求原文已经给了倾向性答案——**「可考虑通过数据公司开放平台／开发者接口采买」**：
甲方自己认为这条路要**花钱买**，而不是爬。这个措辞值得在商务沟通里直接用上。

---

## 8. 建议动作（有序）

1. **先问甲方 P0-3**（引用需求原文「采买」的表述，确认预算与主体）
2. 若本轮只做 P1 加厚：**优先 DTK**——活跃、有 MCP、自托管、Apache-2.0 干净，
   且能补的格子最多（抖音全内容 + 评论 + 归档）。先接只读子集。
3. **接入前先给 `ToolPolicy` 补 `mutating`**（或至少按文件白名单只放只读模块）
4. **xhs 缓接**：先解决三个问题——LICENSE 缺失（许可依据不足）、6.5 个月未更新
   （接口随时失效）、Cookie 依赖（运维风险高）。它的唯一优势是小红书，
   而小红书目前只是 Brief 里的一个可选平台，不是必需。
5. **不要因为接了新源而放松报告侧校验**：R6/R8 与 L4 拦截保持原样，
   新源的 `grade` 一律 L3，`coverage` 里如实写采集口径。
