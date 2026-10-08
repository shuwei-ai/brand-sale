# 外部数据源接入：联网搜索 / 抖音 / 小红书

> 本文对应三个**外部信息入口**的接入状态、契约、合规边界与自检方式。
> 相关代码：`packages/datasource/src/{web-search,douyin-web,xiaohongshu}.ts`、
> `packages/agent-pack/src/tool-impls.ts`、`scripts/{datasource-lab,datasource-smoke}.ts`

---

## 0. 一句话现状

| 源 | 代码 | 真实链路 | 说明 |
|---|---|---|---|
| 联网搜索 `volc_web_search` | ✅ 就绪 | ✅ **实测连通** | 火山引擎联网搜索 Lite，凭 `.env` 里的 Key 抓公开网页 |
| 抖音公开内容 `douyin_web_public` | ✅ 就绪 | ⏳ 待接自托管服务 | 已按**真实 dtk 5.1 路由**对齐（`BM_DOUYIN_STYLE`，默认 v5）；v5 还需建 Key + 加身份。本地联调走 `datasource:lab`（两种形态都提供） |
| 小红书公开内容 `xhs_web_public` | ✅ 就绪 | ⏳ 待接只读代理 | 只读代理（含错误码归一化）已实现并跑通进程级验收；缺的是代理侧那次 `xhs` 登录。填 `BM_XHS_BASE_URL` 即生效 |

**「代码就绪」与「数据就绪」是两件事**，本文所有结论都按这个口径写。
三个源都遵守同一条装配规则：**未配置就不注册**——适配器不存在 → 工具不进 Agent 工具清单 →
模型不会去调一个必然失败的工具。

工具总数：**14 个**（原 10 + 新增 4）。其中 5 个绑定外部源，未配置时缺席。

| 新工具 | 白名单 | 后端 |
|---|---|---|
| `douyin_creator` | CI / CT | 抖音达人主页 + 作品列表 |
| `douyin_comments` | CI | 抖音作品评论 |
| `xhs_creator` | CI / CT | 小红书博主主页 + 笔记列表 |
| `xhs_note` | CI | 小红书笔记详情 + 评论 |

白名单刻意比 `web_search`（六阶段全开）窄。判断标准是「放开它会不会让某条既有不变量失守」：
CT 的不变量是"达人可追溯、禁止编造"。真实采集来的达人不违反这条（可追溯），
但**报价与成交价仍必须来自报价库**——所以工具描述里明确禁止用公开粉丝量推算报价。

---

## 1. 为什么三个源都是 L3，而 `fans_data` 才是 L1

这是本次接入最需要说清的一件事。

```
                与平台的关系              能拿到什么                  分级
联网搜索         无（抓的是公开网页）      行业趋势/政策/竞品动态        L3
抖音 DTK 采集    无合同（公开可见内容）    达人主页/作品/评论            L3  ← 本次
小红书只读代理   无合同（登录态看公开内容）笔记/评论/博主               L3  ← 本次
抖音开放平台     **有**（企业主体+OAuth）  粉丝性别/年龄/地域分布        L1  ← 未接入
```

`TIER_LABEL.L3` 写的是「公开指数与人工核验」。这三个源的后半段（人工核验）**不成立**，
所以每个适配器的 `provenance.note` 都如实写明「未经人工核验、非平台授权实测」，
报告引用时必须带来源站点或账号。

把采集类源标成 L1 是本项目最不能出的错：它会让报告把"公开采集"显示成"甲方授权实测"，
数字的置信度被抬高，而实际上它既不来自甲方后台、也没经过人工核验。
`governance` 的 `assertSourceRegistration()` 从写入口堵住这种伪装：

- **L3 源禁止填 `contractRef`**（`contractRef` 语义是"授权合同"，公开采集没有合同）→ 抛 `E-GOV-005`
- L1/L2 必须同时有 `authMethod` + `contractRef` + `legalApproved: true`

---

## 2. 配置清单

```bash
# 联网搜索
BM_WEB_SEARCH_ENABLED=true
BM_WEB_SEARCH_API_KEY=            # 空 = 能力缺席
BM_WEB_SEARCH_COUNT=20

# 抖音（自托管 DTK）
BM_DOUYIN_ENABLED=true
BM_DOUYIN_STYLE=v5                # v4 | v5，默认 v5
BM_DOUYIN_BASE_URL=               # 空 = 能力缺席
BM_DOUYIN_API_KEY=                # v5 默认强制鉴权
BM_DOUYIN_WAIT=20                 # v5 是秒数（上限 api.max_wait_seconds，DTK 默认 30）
BM_DOUYIN_TIMEOUT_MS=15000
BM_DOUYIN_CACHE_TTL=1800
# 以下四项留空 = 按 BM_DOUYIN_STYLE 取默认路径
BM_DOUYIN_PATH_PROFILE=
BM_DOUYIN_PATH_POSTS=
BM_DOUYIN_PATH_VIDEO=
BM_DOUYIN_PATH_COMMENTS=

# 小红书（自托管只读代理）
BM_XHS_ENABLED=true
BM_XHS_BASE_URL=                  # 空 = 能力缺席
BM_XHS_API_KEY=
BM_XHS_TIMEOUT_MS=25000           # 代理内部含人类化延迟，给得比抖音宽
BM_XHS_CACHE_TTL=1800
BM_XHS_PATH_NOTE=/xhs/note
BM_XHS_PATH_COMMENTS=/xhs/comments
BM_XHS_PATH_USER=/xhs/user
BM_XHS_PATH_USER_POSTS=/xhs/user-posts
```

**注册条件刻意不同**，因为凭据形态不同：`web_search` 是 `enabled && apiKey`（按 Key 计费），
抖音/小红书是 `enabled && baseUrl`（打的是自托管服务，地址在则能力在）。

未配置时启动会打一条告警说明能力缺席，**但不报错**——纯文本入库、无平台数据的情报阶段
依然是完整可用的链路。

---

## 3. 抖音：v4 / v5 是两套完全不同的东西

```bash
BM_DOUYIN_BASE_URL=http://127.0.0.1:8000
BM_DOUYIN_STYLE=v5          # 默认就是 v5（当前仓库 docker compose 装出来的是 dtk 5.1.x）
BM_DOUYIN_API_KEY=...       # v5 默认强制鉴权
BM_DOUYIN_WAIT=20           # v5 是**秒数**；v4 是 true
```

对接 `Evil0ctal/Douyin_TikTok_Download_API`（Apache-2.0，自托管）。它有两代形态，
**差异大到不能共用一套配置**：

| | v4 | v5（dtk 5.1.x） |
|---|---|---|
| 端点 | `GET /api/douyin/web/fetch_user_profile` 等 4 条 | `GET /api/v1/douyin/{user, user/posts, video, video/comments}` |
| 同步 | 直接返回结果 | 默认 `202 + data.{task_id,state}`；`?wait=<秒>` 可同步 |
| 鉴权 | 无 | `X-API-Key` / `Authorization: Bearer`，**默认强制** |
| 信封 | `{code, router, data, router_data?}` | `{success, data, error, meta}` |
| 依赖 | 无 | PostgreSQL + Redis + **身份池**（要先去控制台加身份） |

`BM_DOUYIN_STYLE` 决定四条件路径与 `wait` 的默认值（`DOUYIN_DEFAULT_PATHS` /
`DOUYIN_DEFAULT_WAIT`）。显式设的 `BM_DOUYIN_PATH_*` / `BM_DOUYIN_WAIT` 永远优先，
所以对接"v5 但改了路径"的部署不用改代码。

**形态写错不静默退回默认**：`BM_DOUYIN_STYLE=v6` 直接抛错，而不是按 v5 去请求 ——
后者得到的是四个 404，排查成本远高于当场报错。

### 三个踩过的坑，都写进了代码

1. **`wait` 的语义不同，而且这是类型层面的不兼容**。v4 是布尔开关 `true`；
   v5 是**秒数**，超过 `api.max_wait_seconds`（DTK 默认 30）会被 400 拒掉。
   传 `true` 连 FastAPI 的类型校验都过不了，直接 422。所以"共用一份代码兼容两者"
   这件事**做不到自动兼容**，只能靠 `BM_DOUYIN_STYLE` 显式声明。

2. **v5 把任务句柄放在 `data` 里面**。这是最贵的一个坑：
   ```json
   { "success": true, "data": { "task_id": "…", "state": "running" }, "meta": {…} }
   ```
   只在**顶层**找 `task_id` 的话，这个 202 会被当成成功响应 —— `data` 非空 → 返回 →
   `toCreator({task_id, state})` 得到一行**所有字段为空、但 `synthetic=false`、
   `tier=L3`、口径声称"真实采集"** 的记录。它不报错，只是让报告里多一个
   "查到了但全是缺失"的达人。所以异步判定做了两层，命中就**明确抛错**。

   注意反面：v5 同步成功时 `finished()` 会把 `task_id` 放进 **`meta`**（不是 `data`），
   所以不能"看到 task_id 就判为未完成"。两条都有用例钉着。

3. **4xx 要翻译成动作**。v5 用 401/403、404、400、422 分别表达"没带 Key"、
   "路径不存在"、"wait 超上限"、"参数类型不对"，这四种的排查动作完全不同。
   只抛一句 `HTTP 404` 等于把区别丢掉。

### 只做只读四件套

达人主页 / 作品列表 / 作品详情 / 评论。不做搜索、不做热榜
（v5 里这些端点存在但没进注册表，等于不存在），不做关注/粉丝列表（需登录态）。
不去"补上"它们——那意味着自己去补签名与登录态，等于绕过平台风控。

### 字段归一化是宽容的，不是猜的

上游字段名不稳定（`follower_count` / `fans_count` / `mplatform_followers_count` 都可能出现），
所以按**候选名列表**顺序提取，**取不到就留 `null`**。
宁可下游看到 null（报告里体现为"该项缺失"），也不要编一个看起来合理的数字。

---

## 4. 小红书：只读代理契约

### 为什么必须经代理

可用的开源采集工具（如 `jackwener/xiaohongshu-cli`）三个特点同时成立：

1. 是 **CLI**，不是 HTTP 服务；
2. 需要**登录态 Cookie**，且内置人类化延迟与风控退避；
3. **同时提供写命令**：发笔记 / 点赞 / 收藏 / 评论 / 关注 / 删除。

第 3 条是决定性的。整包封装后，模型可以合法地通过白名单、合法地过闸门，
然后以甲方账号名义发出一条笔记——类型层拦不住，因为"能不能写"取决于**我们封装了哪些子命令**。

所以划一条硬边界：适配器不 spawn 任何东西，只认一个**只暴露只读子命令**的 HTTP 代理。
`scripts/datasource-lab.ts` 里实现了参考代理：命令白名单写死在路由表上，
写命令**根本不存在于**它的路由表里（`XHS_CLI_READONLY` 只有 `read` / `comments` /
`user` / `user-posts` 四条，其余子命令连拼接的机会都没有）。

### 契约

```
GET {baseUrl}/xhs/note?note_id=<id>        或  ?url=<完整笔记链接>
GET {baseUrl}/xhs/comments?note_id=<id>&all=true&count=20
GET {baseUrl}/xhs/user?user_id=<id>
GET {baseUrl}/xhs/user-posts?user_id=<id>&count=20
```

成功响应（与 xiaohongshu-cli 自己的 `{ok, data}` 信封一致，代理几乎可透传）：

```json
{
  "ok": true,
  "meta": { "via": "xhs-cli", "fetchedAt": "2026-10-08T07:30:57Z" },
  "data": {
    "note": {
      "note_id": "…", "title": "…", "desc": "…", "type": "normal",
      "user": { "user_id": "…", "nickname": "…" },
      "interact_info": { "liked_count": 12400, "collected_count": 8900, "comment_count": 431 },
      "tags": ["护肤"], "time": "2026-09-26T00:00:00Z"
    }
  }
}
```

失败响应：

```json
{ "ok": false, "error": { "code": "not_authenticated", "message": "no a1 cookie" } }
```

### 风控失败必须被翻译成可执行的处置

单账号、Cookie 约 7 天有效、可能触发验证码、激进使用会封 IP —— 这些是**常态**。
所以不允许把它们压成一句"接口不可用"：

| 代理错误码 | 适配器给出的处置说明 |
|---|---|
| `not_authenticated` | 代理未登录：需在代理侧执行一次登录后重试 |
| `session_expired` | 登录态已过期（Cookie 约 7 天）：需重新登录 |
| `verification_required` | 触发验证码：需人工在浏览器完成验证，代理会退避冷却 |
| `ip_blocked` | 出口 IP 被限流：需切换网络/出口 IP 并降频 |
| `signature_error` | 请求签名失败：通常是采集工具版本过旧 |
| `tool_missing` | 代理所在机器没装或无法执行 xhs CLI（**代理未就绪，不是小红书侧问题**） |
| `proxy_error` | 代理自身出错（CLI 启动失败/内部异常），看代理日志 |
| `unsupported_operation` | 代理不支持该操作（适配器只请求只读子集） |

每条都能回答"我现在该做什么"。只写"小红书不可用"等于把排查成本推给运营。

### 归一层：CLI 的失败词汇不稳定，不能原样透传

上表要能命中，前提是错误码已经落在契约词汇里。但**真实 CLI 的输出不是这样**：

```
只给一句中文 "登录已过期，请重新登录"          ← 连 code 都没有
给一个自造的码 E_RISK，信息全在 message 里      ← 码不在契约里
连 JSON 都没有，只在 stderr 打 "请求过于频繁，IP 已被限流 (429)" + 非零退出码
英文 "Error: no a1 cookie found, not logged in"
```

原样透传的话，适配器的处置表**永远命中不了**，运营看到的仍是"小红书不可用"——
而归一化存在的唯一理由就是消灭这句话。

所以代理侧多了一层 `classifyXhsFailure()`：按「登录态过期 → 未登录 → 验证码 → 限流 →
签名」的顺序用文案特征识别，把结果压成上表里的**闭合码集**。两条原则：

1. **CLI 若已给出契约里的码，原样尊重**——不要用文案去覆盖一个明确的结构化声明。
2. **认不出来就说认不出来**，退到 `api_error`，并把 CLI 的原始码与原文写进 `message`
   （形如 `[CLI 原始码 E_RISK] 触发验证码…`），不猜、不丢信息。

判定顺序有讲究：`session_expired` 必须排在 `not_authenticated` 前面，因为"登录已过期"
里也含"登录"二字，反过来会把过期误报成未登录；`verification_required` 排在 `ip_blocked`
前面，因为触发验证的文案里常带"风控"。

### 代理未就绪走 5xx，业务失败走 200

`tool_missing` / `proxy_error` 是**代理自身**的问题（没装 CLI、CLI 不可执行、启动超时），
用 503/504/502；`not_authenticated` 等是**小红书侧**的业务失败，与 `xhs-cli` 的失败信封
一致地用 200 返回。

这条区分必须在适配器里被正确对待：HTTP 状态检查若排在信封解析**之前**，
503 会被压成一句 `代理 HTTP 503`，处置表就白写了。所以适配器先解析响应体、
再判状态码，两条路径都汇总到同一张处置表。

---

## 5. 本地联调：`npm run datasource:lab`

一个进程同时提供抖音与小红书两个假后端，用于在没有真实后端时跑通全链路。

```bash
npm run datasource:lab            # 默认 127.0.0.1:8899
npm run datasource:lab -- --xhs-real   # 小红书侧改调真实 xhs CLI（只读子命令白名单）
npm run datasource:lab -- --xhs-real --xhs-bin=/path/to/xhs   # 换一个可执行文件

# 另一个终端
BM_DOUYIN_BASE_URL=http://127.0.0.1:8899 \
BM_XHS_BASE_URL=http://127.0.0.1:8899 npm start
```

`--xhs-bin` 默认是 `xhs`。它的用途是把**归一层**也纳入验收：真要跑一遍
"未登录 / 登录态过期 / 验证码 / 限流 / 签名失败 / 认不出来"这几条路径，得先
`uv tool install xiaohongshu-cli` 再扫码登录 —— 既污染部署机，又没法在 CI 里复现。
所以测试用 `tests/fixtures/fake-xhs.mjs` 顶替：它逐一复刻上面几种真实输出形态，
由 `tests/xhs-proxy.test.ts` 真实 spawn 子进程跑完整链路（含"本机未装 CLI"那条）。

> 夹具的成功响应带 `_lab: { mock: true }`，代理透传、适配器据此把 `synthetic` 置为
> true —— 夹具产出的假数据不会冒充真实采集，`datasource:smoke` 也会打一行醒目提示。

**它不是"内置的假数据源"**，区别在这里：假数据源会伪装成真实源，让报告出现
"看起来像实测值的假数据"（本项目删过一次，不会再犯）。本工具返回的每个响应都带
`_lab: { mock: true }`，适配器据此把 `provenance.synthetic` 置为 **true**。
于是报告层的引用分级会把它降级，`datasource:smoke` 也会打一行醒目提示。

**假数据自己声明自己是假的**，这是底线。

故意失败开关（用来验证降级路径，别只在 happy path 上验收）：

```
?__fail=not_authenticated   → 小红书侧返回该业务错误码
?__fail=http_500            → 返回 500
?__delay=8000               → 延迟 8 秒，验证超时归一化
```

---

## 6. 联通性自检：`npm run datasource:smoke`

单元测试全部打桩 `globalThis.fetch`，验证的是"拿到某种响应之后我们怎么处理"，
**没有**验证 URL 拼接、query 编码、鉴权头、真实响应结构能否被正确解开——
而这一层恰恰是"配置看起来没问题但就是不通"的高发区。

```bash
npm run datasource:smoke
npm run datasource:smoke -- --douyin-sec-user-id=MS4wLjABAAAA...
```

对每个**已配置**的源真发一次请求，打印行数、耗时、`tier`、`synthetic`、口径与样例。
未配置的源只提示、不算失败。退出码：全通 0 / 有源不通 1。

> 它绕过闸门（直接拿适配器）——这是运维诊断工具，不是业务调用，
> 因此它产出的任何数字都不得进入报告。

---

## 7. 合规边界（四条红线）

1. **L3 不得被当 L1 用**。采集类数据只能支撑关于**他人**的公开断言
   （"该达人公开粉丝量 380 万"），**不得**支撑关于甲方自身的断言（"我们店铺 ROI"）。
2. **评论者 IP 属地 ≠ 粉丝地域**。它既是有偏样本（只有会评论的人才被统计），
   口径也完全不同。任何基于它的人群推断都必须标为有偏代理，不得当作粉丝画像。
   适配器与工具描述里都写了这条，报告侧由引用分级兜底。
3. **不接"星图出租 / 品牌过审代办"**。这类服务违反平台条款、有封号风险、
   来源合法性无法证明——走这条路报告里的 `sourceDeclaration` 就是假的。
4. **不封装任何写能力**。`ToolPolicy.mutating` 默认关闭；
   小红书侧的隔离靠"代理路由表里没有写命令"，而不是靠一个布尔开关。

---

## 8. 换成真实后端要做什么

**抖音**：部署 DTK → 把地址填进 `BM_DOUYIN_BASE_URL`。
当前仓库 `docker compose up` 装出来的是 **v5（dtk 5.1.x）**，也就是默认形态，通常不用改别的。
但 v5 比 v4 多两道前置步骤，**只起容器是拿不到数据的**：

1. **建 API Key**（v5 默认强制鉴权）→ 填 `BM_DOUYIN_API_KEY`，
   或把端点加进 `api.public_endpoints` 显式放开；
2. **在控制台加至少一个身份**（identity pool）。没有可用身份时，请求不会报错，
   而是返回 `202 + task_id` —— 适配器会明确报"仍在异步处理中"并提示去补身份。

若你自建的是老的 v4，设 `BM_DOUYIN_STYLE=v4`（路径与 `wait` 语义一起切回去）。

**小红书**：在部署机器上 `uv tool install xiaohongshu-cli` 并完成一次登录，
然后以 `--xhs-real` 模式运行代理（或自行实现同契约的服务），
把地址填进 `BM_XHS_BASE_URL`。若 CLI 不在 PATH 里，可用 `--xhs-bin=<路径>` 指定。

> 代理已经不是待办项了：只读子命令白名单、路由表隔离、错误码归一化都已在
> `scripts/datasource-lab.ts` 里实现，并由 `tests/xhs-proxy.test.ts` 用真实子进程验过。
> 剩下的只有"在一台有登录态的机器上把它跑起来"这一步——**代码就绪 ≠ 数据就绪**，
> 本文件的结论一律按这个口径写。

**验证**：`npm run datasource:smoke` 应显示 `synthetic=false` 且拿到真实行数。
（`synthetic=true` + "联调假数据"说明你打的是 `datasource:lab`，不是真实后端。）

---

## 9. 遗留缺口（主动说明）

1. **粉丝画像（P0-3）本轮未解决，也解不了**。抖音采集回答的是"账号是谁"，
   不回答"账号的粉丝是谁"；小红书根本不暴露关注/粉丝列表。
   真正的路径只有抖音开放平台 `fans_data`（L1）：需企业主体 + 「关系数据」权限审核
   （约 2–3 工作日）+ 达人选 OAuth 授权。**建议商务先行**，代码侧等权限下来再做。
2. **`candidate` 没有逐字段的来源锚点**。creator 产物的候选人可以填采集来的
   `followers` / `contentFit`，来源可靠 `CreatorOutput.citations` 声明，
   但没有"这个数字来自哪一次采集"的字段级指针。想要更细的可追溯性，
   需要在 `packages/agent-pack/src/schemas.ts` 的 candidate 上加一个可选字段
   （如 `publicProfile?: { sourceId; capturedAt; note }`）并同步 skeleton 与 validator。
3. **`TIER_LABEL.L3` 的文案与实际不符**。它写着"公开指数与人工核验"，
   而采集类数据只有前半段。修文案会影响报告页与前端展示，属于独立议题。
4. **小红书侧本质上脆弱**。依赖运营账号的登录态，Cookie 约 7 天、可能触发验证码、
   激进调用会封 IP；`xiaohongshu-cli` 仓库还没有 LICENSE 文件、维护活跃度一般。
   它的定位应是"补充性公开信息"，不能作为关键路径的唯一来源。
5. **成本与配额**：联网搜索按次计费（`maxCallsPerJob=30`，同参数命中缓存不重复请求）；
   抖音/小红书虽是自托管，但背后是有限的账号池与风控额度，
   所以同样设了 `maxCallsPerJob=15`（一次 `*_creator` 调用最多 2 个上游请求）。
