# 七平台采集能力矩阵 × 品牌营销智能体集成方案

> 依据：`services/collector-core/`（内嵌 MediaCrawler 采集内核）逐个平台的真机跑通结果
> （xhs / dy / ks / bili / wb / tieba / zhihu 七平台四算子全部实测通过，2026-10-09），
> 字段结论均对照内核落盘实现逐字段核对，不是推断。

---

## 0. 一句话结论

**七平台在「内容层」能力不一致但可用**——正文、点赞、评论全部拿得到（快手缺内容级评论数）；
**「创作者层」是硬缺口**——粉丝数、简介、性别、地域、头像在七个平台**一个都拿不到**，
这是上游「教学版」为防骚扰刻意移除的，不是接口没写对。

因此集成方案的重心不是"接更多源"，而是三件事：
1. **纠偏**：把已经被真机证伪的能力描述（"creator 能补粉丝量"）改掉，否则模型会一直去调一个必然空手的算子；
2. **让它真的被用上**：平台采集是"首次排队、下次才有"的分钟级异步，而 intel 阶段目前**没有预采集**，
   报告实际上拿不到任何平台数据——这是当前最大的集成断点；
   同时把七个同形工具**收敛成一个 `platform_digest`** —— "哪些指标可比"必须由代码算，不能交给模型；
3. **守住口径**：平台数据是 L3 公开、未经核验，只能支撑"关于他人"的公开断言，绝不能洗成甲方实测经营数据。

> ⚠️ 真机复验的一条硬结论（§4）：**七个平台全量放在一起时，内容层没有任何共有指标**
> （贴吧没有点赞、快手没有评论数，交集为空）。所以"七平台声量横向对比"这件事**本身不成立**，
> 报告必须如实写"不可跨平台对比"，而不是挑一个指标硬比。

---

## 1. 七平台能力矩阵（真机核对）

### 1.1 内容层（`search` / `content_detail` 产出）

统一行字段见 `apps/collector/src/normalize.ts`；下表是**各平台内核真实落盘**的指标，
✅ = 有值，❌ = 该平台记录里根本没有这个字段（不是"取不到"，是"不存在"）。

| 平台 | 正文 | 点赞 | 评论数 | 收藏 | 转发/分享 | 播放/阅读 | 平台独有 |
|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| 小红书 | ✅ `desc` | ✅ `liked_count` | ✅ `comment_count` | ✅ `collected_count` | ✅ `share_count` | ❌ | — |
| 抖音 | ✅ `desc` | ✅ `digg_count` | ✅ `comment_count` | ✅ `collect_count` | ✅ `share_count` | ❌ | — |
| 快手 | ✅ `caption` | ✅ `realLikeCount` | **❌ 无** | ❌ | ❌ | ✅ `viewCount` | 唯一给播放量的短视频平台 |
| B站 | ✅ `desc` | ✅ `like` | ✅ `reply` | ✅ `favorite` | ✅ `share` | ✅ `view` | 弹幕 `danmaku`、投币 `coin`、踩 `dislike` |
| 微博 | ✅ `content` | ✅ `attitudes_count` | ✅ `comments_count` | ❌ | ✅ `reposts_count` | ❌ | — |
| 贴吧 | ✅ `desc` | **❌ 无** | ✅ `total_replay_num` | ❌ | ❌ | ❌ | 指标最贫；评论数含子评论 |
| 知乎 | ✅ `content_text` | ✅ `voteup_count` | ✅ `comment_count` | ❌ | ❌ | ❌ | 回答另带 `question_id`/问题标题 |

要点：
- **正文七平台全有**——这是最稳的一条能力，七平台都能拿到"讲什么"。
- **评论数 6/7**：快手的内容记录只有点赞与播放，**没有评论总数**。
  需要快手的评论热度时只能用 `comments` 算子**计数近似**（返回条数），必须标明是"采样条数"而非总数。
- **指标丰度排序**：B站 > 小红书 ≈ 抖音 > 微博 > 知乎 > 快手 > 贴吧。
  跨平台做"声量对比"时，**只能用各平台都有的指标**（点赞 / 评论数 / 正文），
  用 B站的"投币数"去比小红书是错的。

### 1.2 评论层（`comments` 产出）

| 平台 | 评论正文 | 评论点赞 | 子评论数 |
|---|:--:|:--:|:--:|
| 小红书 | ✅ | ✅ `like_count` | ✅ |
| 抖音 | ✅ | ✅ `like_count` | ✅ |
| 快手 | ✅ | **❌ 无** | ✅ |
| B站 | ✅ | ✅ `like_count` | ✅ |
| 微博 | ✅ | ✅ `comment_like_count` | ✅ |
| 贴吧 | ✅ | **❌ 无** | ✅ |
| 知乎 | ✅ | ✅ `like_count`（另有踩） | ✅ |

要点：
- **评论正文七平台全有**——口碑/情感分析（CI 的 `reputation.sentiment`）有七平台素材。
- **评论点赞 5/7**：快手与贴吧的评论模型里没有点赞字段。
- **子评论默认不抓**：`sub_comment_count` 是"有多少条子评论"的**计数**，
  子评论内容本身默认不下钻，所以贴吧的 `total_replay_num`（含子评论）与实际抓到的条数会对不上，报告需说明口径。

### 1.3 创作者层 —— 粉丝数「全平台缺失」（关键结论）

| 能力 | 覆盖 | 证据 |
|---|:--:|---|
| 该创作者的**公开作品**（落到 `kind=content`） | 7/7 ✅ | creator 算子实测：知乎产出 `creator_contents_*.jsonl` + `creator_comments_*.jsonl` |
| 创作者**资料页**（粉丝数 / 简介 / 性别 / 地域 / 头像） | **0/7 ❌** | 见下 |

**为什么 0/7 —— 三道独立证据互相印证：**

1. **落盘入口是空操作**：`store/{xhs,dy,ks,wb,tieba}/__init__.py:save_creator` 全部
   `return`，注释写明「教学版：创作者个人资料(昵称/性别/头像/签名/IP/粉丝数等)不再落库，防骚扰」。
2. **知乎的实现会写、但根本没人调**：`store/zhihu/__init__.py:save_creator` 会委托 `store_creator`，
   而 `store/zhihu/_store_impl.py:store_creator` 是 `pass`；且 `media_platform/zhihu/core.py`
   **从不调用** `save_creator`；B站同理（core 不调用）。
3. **实测落盘目录里没有任何 `creators_*.jsonl`**：只有 `creator_contents_*` / `creator_comments_*`
   ——即"这个人的作品"，不是"这个人的主页"。

> ⚠️ 这条直接推翻了此前两处文档/提示词里的说法（"creator 可补粉丝量"），
> 是本次真机验证暴露的核心事实修正，已在 §3 P0 落地纠偏。

### 1.4 缺口合集（主动说明，不静默省略）

| 缺口 | 范围 | 影响 | 正确补法 |
|---|---|---|---|
| 粉丝数 | 七平台全缺 | CT 的 `followers` 字段无平台来源 | KB-2 私域库 / 报价库；或 L1 官方通道（见 §3 P3） |
| 创作者画像（性别/地域/年龄） | 七平台全缺 | 人群洞察不能从平台侧得出 | 抖音开放平台 `fans_data`（需企业主体 + 达人 OAuth，**未就绪，不注册**） |
| 快手内容级评论数 | 仅快手 | 跨平台评论热度对比出现空列 | 用 `comments` 采样条数近似 + 标注口径 |
| 快手/贴吧评论点赞 | 两平台 | 评论排序不能按赞 | 按时间序；或标 null |
| 贴吧点赞/收藏/转发/播放 | 仅贴吧 | 贴吧帖只能做"正文 + 评论数"分析 | 如实写 null |
| B站粉丝/关注列表 | 仅B站 | — | 内核调用被注释、无开关，**不要**写成算子 |
| 数据时效 | 七平台 | 采集可能是数分钟前的缓存 | provenance.asOf 如实标注；报告中说明采集时点 |

---

## 2. 智能体 × 能力映射

六个智能体（`packages/contracts/src/agent.ts`）：AO 任务录入 / CI 竞品情报 / CT 人选匹配 /
PL 打法排期 / BR 预算风控 / RG 研报生成。
平台工具的当前白名单是 `["CI", "CT"]`（`tool-impls.ts` `makePlatformTool`）——**这个白名单是对的**，
下面说明每一个"要"与"不要"的理由。

| 智能体 | 需要平台能力？ | 用哪些算子 | 具体用途 | 现状 |
|---|:--:|---|---|---|
| **AO** 任务录入 | 否 | — | 只做 brief 解析与授权核验，不产生内容断言 | ✅ 正确排除 |
| **CI** 竞品情报 | **是（核心）** | `search` / `content_detail` / `comments` | 竞品内容题材矩阵 `contentMatrix`、差异化定位、口碑情感 `reputation`、类目题材趋势 | ⚠️ 已授权，但**实际用不上**（见 2.3） |
| **CT** 人选匹配 | **是（辅助）** | `creator` / `search` | 候选达人的**作品样本** → `contentFit`；证明"这个人平时讲什么" | ⚠️ 已授权，但 `followers` 无平台来源（见 2.3） |
| **PL** 打法排期 | 否 | — | 排期依据方法论文档与历史执行库，不需要平台公开内容 | ✅ 正确排除 |
| **BR** 预算风控 | 否 | — | 预算/ROI 必须来自授权数据与报价库，**绝不能用公开粉丝量倒推报价** | ✅ 正确排除（这条尤其重要） |
| **RG** 研报生成 | 否（间接） | — | 通过上游阶段产物 + `cite_fact` 引用 L3 来源，不直采 | ✅ 正确排除 |

**为什么 PL/BR/RG 不给平台工具：**
- PL 的排期是"我方要做的事"，平台公开内容讲的是"别人已经做了什么"，两者没有因果；
- BR 一旦能读平台数据，最危险的用法就是"拿公开粉丝量 × 行业单价倒推报价"——这是把 L3 公开信息洗成
  预算依据，`doc/datasource-integration.md` §7 明令禁止；
- RG 若直采，报告里的数字将绕过 `cite_fact` 与来源声明，破坏"每个数字可追溯"这条硬约束。
  让 RG 只消费上游产物，是**刻意的单向依赖**。

### 2.3 四个真实的集成断点（能力有了 ≠ 用得上）

> 以下三个断点是**提出方案时**的诊断，均已在 §3 落地修复；此处保留原诊断以便追溯。

**断点 A：intel 阶段没有平台预采集 → CI 实际拿不到数据。**
`agents.ts:prefetch()` 的 `case "intel"` 只跑 `kb_retrieve ×3` +（可选）`web_search`，
**没有任何平台采集**。而平台采集是"首次调用返回 0 条 + 后台排队、下次才有"的分钟级异步
（`media-crawler.ts` `dispatchCollect`）。pi-agent 循环里 CI 第一次调平台工具只会拿到
`count: 0` 和一句"已排队"，报告随即生成 → **平台数据等于白接**。
这是当前最大的断点，`config.webSearch.prefetch` 已有现成范式可照搬。

**断点 B：CT 的 `followers` 必填，但平台给不了。**
`schemas.ts:CreatorCandidatesSchema` 里 `followers` 是必填 number；`synthCreators` 也只从
`pricing_query` 取。真机上 creator 算子拿不到粉丝数 → 只能靠 KB-2/报价库，取不到就是 0。
现状没有明确告诉模型"别指望平台给粉丝数"，模型会反复重试。

**断点 C：提示词里的能力描述与真机不符（会诱发无效调用）。**
`tool-impls.ts:PHASE_TOOL_HINT.creator` 现写着「候选人的公开背景可用平台内容工具的 creator 算子补
（**粉丝量**、作品与互动）」——**粉丝量拿不到**，这句会让 CT 反复去调一个必然空手的路径。

**断点 D：工具面本身（七个同形工具并列，合并与可比性判断留给模型）。**
七个平台工具形状几乎相同，模型要在其中挑平台，拿到结果后**必然在上下文里手工合并**。
而"哪些指标可比"是确定性计算、且正是 LLM 最容易犯错的地方（§1.1 的指标丰度差异就是陷阱）。
正确做法是把七个收敛成一个聚合入口，由代码算交集 —— 见 §3 P1′。

---

## 3. 集成方案

按优先级分四批。**P0 / P1 / P2 已落地并验证**（`typecheck` ✅ / `check:boundaries` ✅ / `npm test` **130/130** ✅），
P3 是缺口的长线解法，仅登记不实现。

### P0 · 事实纠偏 —— ✅ 已落地

| 动作 | 位置 | 状态 |
|---|---|---|
| P0-1 | `packages/agent-pack/src/tool-impls.ts` `PHASE_TOOL_HINT.creator` | ✅ 已改为「补**作品样本**做内容契合度判断；**粉丝量/画像平台侧拿不到**，只能来自报价库或 KB-2」 |
| P0-2 | `docs/datasource-integration.md` §4 | ✅ creator 算子产出改为「**该创作者的公开作品**」；补"粉丝数七平台全缺"+ 指标不一致提示 |
| P0-3 | `services/collector-core/README.md` | ✅ 修正 3 处：`save_creator` 空操作表（原"只有 zhihu 真的落盘"是错的）、「`kind=creator` 只有知乎产得出来」（错，七个平台都产不出来）、`--type creator` 的"创作者主页"措辞 |

### P1 · 让能力真正被用起来 —— ✅ 已落地

**P1-1　intel 阶段加"平台预采集"。** 实现在 `agents.ts:prefetch()` 的 `case "intel"`：
在 `web_search` 预取之后，投递**一次 `platform_digest`**（`op:"search"`、`keyword: brief.category`、
`platforms: brief 声明的平台`、`limit: 20`，参数由 `platformPrefetchArgs()` 纯函数构造）。
前置四重，缺一即跳过：① 三道门（`mediaCrawlerReady`）；② `!gateway.mocked`；
③ 聚合工具已装配（`registry.get`）；④ brief 至少有一个可映射平台。

- 业务平台码 → 采集平台码的映射抽成 **`BRIEF_PLATFORM_TO_MC`**，定义在 `@brandsale/config`
  （`agents.ts` 再导出）：`douyin→dy` / `xiaohongshu→xhs` / `bilibili→bili` / `weibo→wb`。
  两套编码不通用，写死在一处 —— 放在 config 是因为聚合工具也要用它做参数别名归一。
- **只投递、不等待**：这一层拿到的多半是 0 条 + "已排队"，真正的数据在**下一次**（CI 的工具循环或重跑）
  才命中缓存。采集是分钟级，不能阻塞 intel。
- 快手 / 贴吧 / 知乎不在 `Brief.platforms` 候选集里，**刻意不映射**——预采集不替客户没要的平台凭空造主张；
  确有需要时由 CI 在工具循环里按需指定（`platform_digest.platforms` 接受全部七个采集码）。

### P1′ · 能力聚合：模型可见面收敛为单个 `platform_digest` —— ✅ 已落地

原实现把七个平台各做成一个工具，全部暴露给模型。实测这条路的两个问题都很真实：
模型要在七个同形工具里选平台、并且**必然在上下文里手工合并跨平台结果**——而"哪些指标可比"
恰恰是 LLM 做不准的部分（§1.1 的指标丰度差异就是陷阱）。

现在的形态：

| 层次 | 内容 |
|---|---|
| **模型可见** | 只有 `platform_digest` 一个平台入口（`list()` / `toAgentTools()` 都过滤 `policy.hidden`） |
| **受治理原语** | 七个 `*_web` 工具仍注册、仍各绑各的 `mc_*` 源、仍逐个过闸门；只对模型隐藏（`hidden: true`），单测仍直接调用 |

聚合工具做了三件确定性的事（都不该交给模型）：

1. **逐源过闸门**。`policy.boundSourceIds` 绑七个源，但每个平台仍按自己的 `sourceId` 单独跑
   `scope/source/authz/tenant`；未通过的平台**跳过并记名**（`platformsSkipped`），不拖垮整批。
   这是"绑一组源 ≠ 放开来源"的落地形式。
2. **算可比指标**。`comparison.metrics` = 本组平台 `contentMetrics` / `commentMetrics` 的**交集**
   （按算子选表：`comments` 走评论表，其余走内容表），再剔掉"声明共有但本批一条非零值都没有"的指标
   （后者进 `comparison.dropped`，语义是**缺失而非 0**）。
3. **合并 + 打平台标签**。`rows[].platform` 让合并后仍能分辨来源；`platforms[].absentMetrics`
   逐平台列出"我声明有、但这批没值"的指标。

配套：
- **P1-2　CI 提示词**：`prompts.ts` CI 段【平台内公开内容】改为围绕 `platform_digest` 写，
  并明确"跨平台横向对比只允许落在 `comparison.metrics` 上"，`dropped` / `platformsSkipped` 按缺失处理。
- **P1-3　CT 提示词**（`【达人公开作品与粉丝量】`）：`creator` 只给**作品**（`contentFit` 的定性证据）；
  followers 只能来自 `pricing_query`/KB-2，缺失写 0 + 低 confidence + 说明"无授权来源"；
  **禁止用作品互动量倒推粉丝量**；`creatorId` 须原始 UID。`PHASE_TOOL_HINT` 两段同步改写。

### P2 · 报告口径 —— ✅ 已在提示词层落地

| 动作 | 位置 | 状态 |
|---|---|---|
| P2-1 | `prompts.ts` RG 段【竞品格局页 · 跨平台指标口径】 | ✅ 只用作数工具返回的 `comparison.metrics`；**没有 `comparison` 时不许自己猜共有指标**，改为逐平台陈述或写明"跨平台不可比" |
| P2-2 | 同上 | ✅ 采集时点（`asOf`）与样本量写进口径说明；L3 引用的 citation 用 `tier: "low"` + `mc_*` sourceKey + 注明"公开采集" |
| P2-3 | 同上 + 既有 `sourceDeclaration` 契约 | ✅ 未采到的平台写"无数据"、不得写 0；`platformsSkipped` 的平台进 `exclusions` 并写明原因 |

> P2-2 的"机械注入 asOf"（由 `render_outline` 自动带出，而非依赖模型自觉）尚未实现 —— 目前靠提示词约束。

### P3 · 粉丝数缺口的正确补法（不在本次范围，仅登记）

粉丝量/画像**不要**试图从公开内容侧绕（把作者所有作品的互动量加起来猜粉丝量是编造）。
唯一正确路径是 **L1 官方通道**：抖音开放平台 `fans_data`，前置条件是企业主体 + 权限审批 + 达人 OAuth。
在就绪之前：
- `config.tiers.L1` 保持关闭，适配器**不注册**；
- CT 的 `followers` 走 KB-2/报价库；缺失时如实标 0 + 低置信度 + 说明原因。

### 排期与验收

| 批次 | 内容 | 验收状态 |
|---|---|---|
| P0 | 纠偏三处 | ✅ 全文不再出现"creator 算子补粉丝量"；文档 §4 与真机一致 |
| P1 | 预采集 + 能力聚合 + 两处 prompt | ✅ 单测 9 条（见 §4）；**每条断言均做突变检查**（见 §4 末） |
| P2 | 报告口径 | ✅ 提示词层落地；既有报告校验用例无回归 |
| P3 | 登记 | ⬜ 仅登记，不做实现 |

---

## 4. 真机复验（聚合层）

用一个临时脚本把 `platform_digest` 接到**本机真实 collector**（七个平台都已有真实采集缓存）上跑，
不进版本库。结果如下 —— 这几条都是"只有真数据才会暴露"的事实：

| 场景 | 真实结果 | 意义 |
|---|---|---|
| `op=search`，小红书 + 抖音 + 快手 + B站 | `comparison.metrics = ["likes"]` | 快手没有评论数/收藏/转发，B站多出的播放量也不参与交集 → **四个平台只剩点赞可比** |
| `op=search`，全部七个平台 | `comparison.metrics = []`，note 明说"不可做跨平台横向对比" | **七平台全量在内容层没有任何共有指标**：贴吧没有点赞、快手没有评论数，交集为空。这是报告口径页必须如实写出来的结论 |
| 逐平台 `absentMetrics` | 快手此行 `absent: ["likes"]` | 声明有、本批为 0 → 单列出来，避免"当 0 用" |
| `op=comments` 且在无缓存的内容上 | `dropped: ["likes","subComments"]`，note 说"已在后台排队采集" | 评论层可比集切到评论表；无数据时如实报缺失而不是 0 |
| 模型可见工具 | 11 个，含 `platform_digest`；七个 `*_web` 已隐藏但仍注册 | 工具面收敛生效 |

### 回归用例与突变检查

`tests/platform-collect.test.ts` §6/§7/§8 共 9 条新用例（编号 15–23），**每条都做过突变检查确认会红**：

| 用例（编号） | 突变 | 结果 |
|---|---|---|
| 预采集参数：只覆盖 brief 声明的平台（15） | 去掉平台去重 | ✅ 红 |
| 能力矩阵：指标声明与真机结论一致（16） | 给快手补上 `comments` | ✅ 红 |
| 模型可见工具面只有 `platform_digest`（20） | 去掉单平台工具的 `hidden: true` | ✅ 红 |
| 聚合工具：多平台合并 + 可比指标（17） | 不再区分"声明共有但本批全为 0" | ✅ 红 |
| 聚合工具：可比集退化成首个平台声明集（22） | 用 `MEDIA_CRAWLER_PLATFORM_META[used[0]]` 代替交集 | ✅ 红 |
| 未装配任何平台源时不注册聚合工具（21） | 去掉 `boundSourceIds` 准入判定 | ✅ 红 |
| 聚合工具：逐源过闸门（23） | 去掉逐源 `gate.evaluate` | ✅ 红 |

---

## 附录 A · 证据索引

| 结论 | 证据位置 |
|---|---|
| 七平台算子统一为四个 | `packages/config/src/index.ts` `MEDIA_CRAWLER_PLATFORM_META` |
| 平台工具白名单 = CI/CT | `packages/agent-pack/src/tool-impls.ts` `makePlatformTool` |
| 内容层字段映射 | `apps/collector/src/normalize.ts` `CONTENT_FIELDS` |
| 快手内容无评论数 | `store/kuaishou/__init__.py:update_kuaishou_video`（仅 liked_count / viewd_count） |
| 贴吧内容无点赞 | `model/m_baidu_tieba.py:TiebaNote`（仅 total_replay_num） |
| 粉丝数 0/7 | `store/{xhs,dy,ks,wb,tieba}/__init__.py:save_creator` 全 `return`；`store/zhihu/_store_impl.py:store_creator` = `pass`；`media_platform/{bilibili,zhihu}/core.py` 不调用；实测无 `creators_*.jsonl` |
| 预采集范式 | `packages/agent-pack/src/agents.ts:prefetch()` `case "intel"` |
| 预采集映射（业务码→采集码） | `packages/agent-pack/src/agents.ts:BRIEF_PLATFORM_TO_MC`（已导出，测试钉着） |
| 预采集回归用例 | `tests/platform-collect.test.ts` 第 5 节两条（映射覆盖 + mock 不联网） |
| CI/CT/RG 提示词边界 | `packages/agent-pack/src/prompts.ts` 的【平台内公开内容】/【达人公开作品与粉丝量】/【竞品格局页 · 跨平台指标口径】 |
| 采集异步形态 | `packages/datasource/src/media-crawler.ts:dispatchCollect` |
| CT 的 followers 必填 | `packages/agent-pack/src/schemas.ts:CreatorCandidatesSchema` |
| 业务平台 vs 采集平台两套编码 | `packages/contracts/src/common.ts:POPULAR_PLATFORMS` |
