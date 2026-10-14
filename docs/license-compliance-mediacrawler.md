# MediaCrawler 商用许可处置方案

> 状态：**待决策**（2026-10-14 建立）｜ 适用范围：`services/collector-core`（七平台采集链路）
> 本文是**处置方案**，不是法律意见。最终定性请由法务确认。

---

## 0. 一句话结论

要在商用场景下用这套内核，**唯一的硬门槛是取得版权方（relakkes@gmail.com）的书面同意**。
许可证条件第 3 条把"未经书面同意的商业用途"直接禁止，没有替代解释空间。

而仓库当前处在一个**比"未处理"更被动**的状态：有三处地方已经对外宣称"已获批准 / 已取得书面同意"，
却**没有任何凭据**。一旦审计或对方主张权利，"声称做过"+"拿不出东西"的落差本身就是风险点。

---

## 1. 许可证的三条关键条件

上游 `services/collector-core/LICENSE` 为 `NON-COMMERCIAL LEARNING LICENSE 1.1`，
版权人 `relakkes@gmail.com`。对本项目有实质影响的是这三条：

| 条款 | 原文要点 | 对本项目的含义 |
|---|---|---|
| **条件 1**（`LICENSE:16` / `:46`） | 使用者必须在软件及其副本的**所有合理显著位置**包含版权声明与本许可证声明 | 授权范围的**对价**。`LICENSE` 与 129 个源文件头的版权头**不可删**；本项目目前这一点是"自动正确"的 |
| **条件 2**（`LICENSE:17` / `:47`） | 仅限学习/研究；不得大规模爬取或干扰平台运营 | **本项目已合规**，见 §2.3 |
| **条件 3**（`LICENSE:18` / `:48`） | 未经版权所有者**书面同意**，不得用于任何商业用途 | **这是唯一的硬门槛**。brandsale 是商业交付系统（报告直接指导甲方真实投放预算），必然落入此条 |

授权范围原文是 "use, copy, modify, and merge" —— 修改与裁剪本身**被允许**，
但"修改"不等于"可以不署名"，也不等于"可以商用"。

---

## 2. 当前状态核查

### 2.1 "已批准"断言与凭据

| # | 位置 | 断言内容 | 状态 |
|---|---|---|---|
| 1 | `.env:75` | `BM_MC_LICENSE_ACK=true` | 裸布尔，无批准人/日期/文件 |
| 2 | `scripts/seed.ts:69` | `legalApproved: true`（硬编码在每个 `mc_*` 源上） | 对 L3 不执法，见 §2.2 |
| 3 | ~~`docs/datasource-integration.md:105`~~ | ~~「已取得版权方（relakkes@gmail.com）的**书面同意**」~~ | **2026-10-14 已删除**（该断言无凭据，见下） |

第 3 条原本是一句**无法证实的合规声明**：对全仓做 `find` 检索
（`*consent*` / `*授权*` / `*agree*` / `*LICENSE*`），**只命中上游自带的
`services/collector-core/LICENSE`** —— 没有同意书，没有授权函，没有法务意见书，
也没有任何指向仓外存放位置的记录。已在 2026-10-14 删除该句，改为指向本文档。

> 注：删除该句**只影响"我们自己的叙述"**，不影响任何法律状态 ——
> 许可证义务来自上游 LICENSE 本身，与本仓库怎么写无关。真正的待办仍是 §6 的 #1–#3。

### 2.2 闸门的真实执法范围（关键）

- **真正管用的只有 `BM_MC_LICENSE_ACK`**：`packages/config/src/index.ts:635` 读取，
  `packages/datasource/src/media-crawler.ts:54` 的 `mediaCrawlerReady()` 据此决定是否装配
  七个适配器与七个工具。它是个**裸布尔** —— 没有批准人、没有日期、没有对应文件。
- **`scripts/seed.ts:69` 的 `legalApproved: true` 对 L3 源不产生任何拦截作用。**
  governance 中所有 `legalApproved` 判定都写成 `tier === "L4" && !legalApproved`：
  `packages/governance/src/gate.ts:118`、`:191`、`packages/governance/src/source-guard.ts:95`。
  七源是 **L3**，所以这条字段在本 tier 上**是装饰性的**。
- 两者叠加的后果：**台账上写着"法务已批准"，但那条字段不参与任何判定，因此没有人会去核对它的依据。**
  这是一个"看起来被管住了、实际只靠一个环境变量"的空洞。

### 2.3 条件 2（规模限制）反而是合规的

这一项不需要额外动作，现状已满足，可作为对外说明的正面证据：

- 单次采集条数默认 **50**、硬上限 **200**（`apps/collector/src/config.ts:137-138`：
  `BM_MC_MAX_ITEMS` / `BM_MC_MAX_ITEMS_CAP`，`tasks.ts:176` 取两者最小值）。
- 内核单进程串行（`MAX_PENDING=12`、`MAX_PROFILE_BACKLOG=64`），不存在并发洪峰。
- 只暴露四个**只读**算子（`search` / `content_detail` / `comments` / `creator`）；
  上游自带的点赞/评论/关注/发帖能力在接口形状上就无从表达，`tools.allowMutating` 默认 `false`。

---

## 3. 三条路线

### 路线 A：取得版权方书面同意（推荐）

**为什么推荐**：它是唯一能把条件 3 从"风险敞口"变成"已关闭"的做法；
路线 B 成本高，路线 C 只是把风险显性化、并未消除。

**同意书必须覆盖的要点**（缺任何一条都可能留后患）：

1. **明确许可"商业用途"** —— 对应条件 3，用词要能覆盖"SaaS 交付给甲方、报告含据此得出的结论"。
2. **明确处理条件 1 的署名义务** —— 若希望移除或替换署名，**必须写进同意书**；没写就只能保留。
3. **明确允许修改、裁剪并以其衍生作品交付** —— 本项目已裁剪 `libs/*.js` 与部分能力。
4. **主体范围** —— 写清被授权方的**法人实体全称**，以及是否覆盖其甲方/客户。
5. **期限与地域** —— 永久还是若干年；是否全球。
6. **可否转让 / 可否再许可** —— 涉及公司被收购、外包交付等场景。
7. **条件 2 的规模约定** —— 直接引用并确认本项目的 50/200 与串行策略，避免"大规模"的模糊解释。
8. **对标版本** —— 写明对应上游的哪个 commit / 版本，避免上游后续改版后范围争议。
9. **双语或约定语言** —— 若对方只出英文，需明确以英文为准并做好内部翻译存档。

**验收标准**：

- 同意书原文入仓（建议 `docs/legal/`，并在 `docs/` 里留指针）。
- `.env` 与 `scripts/seed.ts` 改为**引用具体文件编号**，而不是继续写裸 `true`（见 §4）。
- 台账里 `mc_*` 的 `legalApproved` 有可追溯出处。

**风险**：进度不由我方控制。**建议在启动路线 A 的同时并行准备路线 B 的可行性结论**，
以便对方拒绝或不回应时有 Plan B。

### 路线 B：替换采集内核

彻底解除双许可证（非商用 + 上游署名）约束，但成本集中在最难自动化的部分。

**必须保持不变的契约面**（否则下游全线返工）：

- 8 源 / 17 工具的对外形状；`mc_xhs`…`mc_zhihu` 这七个 `sourceId` 与各自 tier（L3）。
- 四个算子的语义；归一化行的字段形状；`CREATOR_ROW_TYPE` 资料行的分列约定。
- 落盘目录名契约（`bili→bili`、`dy→douyin`、`ks→kuaishou`、`wb→weibo`，**不是** `bilibili`）。
- `id`/`url` 必须能喂回 detail/comments 的形态约束（B站 BV、微博不用 `m.weibo.cn/detail/`、知乎双形态）。
- 模型侧唯一入口仍是 `platform_digest`，`comparison.metrics` 的"交集"语义不变。

**成本集中点**：

- 七个平台的**登录态维持**（扫码、Cookie 刷新、风控对抗）。
- **签名 JS**：小红书、抖音、知乎各有独立签名逻辑，这是上游最厚的一块资产。
- 上游已有的反检测措施（`libs/stealth.min.js`）需要重新实现。

**结论**：不是"重写一遍代码"，而是"重建一套对抗能力"。适合作为**长期解**，
不适合作为本期交付的阻塞项。

### 路线 C：法务书面接受风险

`docs/datasource-integration.md:106` 已把这条例为备选。若走这条：

- 需要**具名**的风险评估书，写清接受的是"未获书面同意即商用"的后果；
- 需要公司层决策记录（谁批的、什么权限）；
- **仍然不能顺手删条件 1 的署名** —— 接受条件 3 的风险，不代表放弃条件 1 的对价。
  删署名会把"合同风险"升级为"侵权"，是纯粹的下行风险。

---

## 4. 工程加固（与选哪条路线无关，建议都做）

当前设计的根本问题是：**合规状态只活在一个环境变量里，没有溯源、没有制衡**。四处加固：

1. **给 `BM_MC_LICENSE_ACK` 加溯源**：新增 `BM_MC_LICENSE_REF`（同意书的编号 / 日期 / 存放位置）。
   启动自检时若 `ACK=true` 而 `REF` 为空 → 告警。让"已确认"必须指向一个**具体凭据**。
2. **消除双重声明漂移**：`scripts/seed.ts:69` 的 `legalApproved: true` 改为由
   `BM_MC_LICENSE_ACK`（或 `REF` 是否存在）**派生**，避免台账与 env 两处各自声明、可能不一致。
3. **prod 下强制**：`assertConfigInvariants`（`packages/config/src/index.ts:673`）增加一条
   —— `env === "prod" && mediaCrawler.enabled` 时要求 `BM_MC_LICENSE_REF` 非空。
4. **不动条件 1 的署名** —— 它是现在唯一"自动正确"的合规项，动它只减分。

> 这四条与路线 A 是互补的：拿到同意书后，`BM_MC_LICENSE_REF` 正好指向它；
> 若最终走路线 C，`REF` 就指向法务的风险评估书。**无论哪条路，这个字段都有归宿**，
> 所以可以先行落地，不必等许可结论。

---

## 5. 附录：书面同意申请函模板

> 建议以中英双语发往 `relakkes@gmail.com`，主题行点明来意，正文控制在半屏内。
> 发信前请补齐 `【】` 中的主体信息，并请法务过一遍。

**Subject:** Commercial license request — vendor inquiry for MediaCrawler (NON-COMMERCIAL LEARNING LICENSE 1.1)

Dear relakkes,

I am 【姓名】, 【职位】 at 【法人实体全称】. We use MediaCrawler as the collection kernel
inside our commercial product, distributed as a hosted service to our clients.

We have read your license carefully, and we want to do this properly:

1. **Commercial use.** Condition 3 requires your prior written consent for any commercial use.
   We would like to request that consent, covering our product and its delivery to our clients.
2. **Attribution.** Condition 1 requires retaining the copyright notice and license statement.
   We currently retain both in full. If you prefer a different attribution format, or would allow
   a shorter notice, please let us know — we will follow your instruction rather than assume.
3. **Modified distribution.** We ship a trimmed copy: we removed the write-side capabilities
   (posting / liking / commenting / following) and only keep read-only collection. We would like
   this covered explicitly.
4. **Scale discipline.** We cap collection at 50 items per run (hard limit 200) and run strictly
   serially, in line with Condition 2. We are happy to have this written into the consent.

We are asking for: 【期限，例如 a perpetual / 3-year】, 【地域，例如 worldwide】,
non-exclusive, non-transferable unless you agree otherwise.

If a plain email confirming the above is acceptable to you, that is enough for us — we will
archive it as our authorization record. If you would rather use a short written agreement,
we are glad to sign whatever form you prefer.

Thank you for the work you have put into this project.

Best regards,
【姓名】 · 【公司】 · 【邮箱】 · 【日期】

---

**中文摘要**（随信附上，便于对方理解）：

> 我方为【公司全称】，在商业产品中以子进程方式内嵌 MediaCrawler 作为采集内核，
> 以托管服务形式交付给客户。依据许可证条件第 3 条，特此请求贵方**书面同意商业用途**。
> 我方现状：**完整保留**版权声明与许可证声明（条件 1）；已移除全部写侧能力，仅保留只读采集；
> 单次采集上限 50 条（硬上限 200）且严格串行（条件 2）。
> 请求范围：期限【　】、地域【　】、非独占。若邮件确认即可，我方将留存为授权凭据；
> 若贵方希望签署正式协议，我方愿配合贵方格式。

---

## 6. 待办

| # | 事项 | 负责方 | 阻塞关系 |
|---|---|---|---|
| 1 | 确认主体：以哪个法人实体申请授权 | 业务 | 阻塞申请函 |
| 2 | 补齐 `【】` 并请法务复核申请函 | 业务 + 法务 | 依赖 #1 |
| 3 | 发出申请函，留存发送记录 | 业务 | 依赖 #2 |
| 4 | **并行**：评估路线 B 的可行性结论（作为 Plan B） | 工程 | 无 |
| 5 | 落地 §4 的四处加固（`BM_MC_LICENSE_REF` 等） | 工程 | 无 |
| 6 | 拿到同意书后归档到 `docs/legal/`，并把 §2.1 三处断言改为引用它 | 工程 | 依赖 #3 |

> ✅ **2026-10-14 已处理**：`docs/datasource-integration.md` 中那句无法证实的
> 「已取得书面同意」已删除，改为指向本文档。仓库里不再有未经证实的合规声明。
> 剩下的是 §6 的实质性待办 —— 它们不是"写一句话"能解决的，需要真实凭据。
