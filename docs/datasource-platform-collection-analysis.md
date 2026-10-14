# 平台内公开内容采集：MediaCrawler 接入评估与源码内嵌落地

> 评估日期：2026-10-09 ｜ 决策更新：2026-10-09（同日实施）
> 评估对象：MediaCrawler（下称 **MC**）。上游原始 checkout 在 `/Users/lsy/code/MediaCrawler`；
> 其**采集内核现已内嵌到本仓库** [`services/collector-core/`](../services/collector-core/)（见 §决策更新）
> 及其接口清单工具 `interface_extract/extract_interfaces.py`
>
> 本文记录三段：
> 1. **移除** `douyin_web_public` / `xhs_web_public` 两条适配器与四个工具（已执行）；
> 2. 对 MC 本体的评估（许可证、架构、能力上限、运行时栈）；
> 3. **决策更新**：采纳"复用 MC 采集内核并**源码内嵌**进本仓库"方案，已落地为七个平台源
>    （内核在 `services/collector-core/`）。

---

## ⚠️ 决策更新（2026-10-09，已实施）

**本文 §0 与 §5 的原始建议是"不接本体"。该建议已被推翻并取代。**

产品方在明确知晓下述前提下，选择了**复用 MC 的采集内核**：

- 已知并接受 MC 的 `NON-COMMERCIAL LEARNING LICENSE 1.1`（条件第 3 条禁止未经
  版权方书面同意的商业用途）所带来的合规风险；
- 形态为**源码内嵌**：把 MC 的采集内核（`media_platform/` 等）搬进本仓库
  `services/collector-core/`，只保留采集所必需的部分（剔除 `webui/`、`api/`、
  `database/`、`docs/`、`test(s)/`，以及词云 / 数据库类依赖），并新增薄入口 `run.py`
  取代其 `main.py` + Typer CLI。**部署上只有 brandsale 一个系统**，不再需要独立的
  MediaCrawler 进程与端口；
- 与主程序之间仍隔一层只读归一化服务 `apps/collector`，它以**子进程**方式驱动内核。

落地结果（实现细节见 [`datasource-integration.md`](./datasource-integration.md)；
内核来源、许可与逐文件裁剪清单见 [`services/collector-core/README.md`](../services/collector-core/README.md)）：

| 项 | 结果 |
|---|---|
| 平台覆盖 | 七平台全接：小红书 / 抖音 / 快手 / B站 / 微博 / 贴吧 / 知乎 |
| 架构 | `apps/collector(归一化+缓存)` ──spawn──▶ `services/collector-core(内嵌采集内核)`；上游 ← `packages/datasource` 七个适配器 |
| 工具 | 新增 7 个：`xhs_web` / `douyin_web` / `kuaishou_web` / `bilibili_web` / `weibo_web` / `tieba_web` / `zhihu_web` |
| 分级 | 全部 L3（公开、未经人工核验、与平台无授权合同） |
| 许可闸 | `BM_MC_LICENSE_ACK` 必须显式为 true，否则整条链路不装配 |
| 运行时 | 仓库内 Python 3.11+（`npm run collector:setup`）+ Playwright chromium；扫码登录，登录态落在 `<coreDir>/<平台>_user_data_dir/` |
| 能力边界 | 仍是内容层（搜索/详情/评论/创作者）；**粉丝画像七平台全无**（§3 的 P0-3 结论不变） |

因此：本文 §1–§4 的**技术评估依然是准确且有用的**（尤其是"MC 的任务控制面不能直接当
适配器用"这一条——它正是 collector 这层存在的原因），§5 的"四个方案"则仅作选型留档，
**实际采纳的是方案 B（复用本体）+ 源码内嵌**；方案 C（自研只读 sidecar）因工作量与
签名维护成本被放弃，方案 D（L4 授权源）仍是解 P0-3 的唯一路径。

---

## 0. 结论速览（原始评估，建议部分已废止）

**MC 是一份很好的「平台接口地图」，同时也是一个带许可风险的采集后端。**

| 判断 | 结论 |
|---|---|
| 能不能拿到粉丝画像（P0-3）？ | **不能。七平台全都拿不到** —— 不是解析问题，是公开 Web 接口层没有这个数据 |
| 能不能补平台内内容层（达人/作品/评论）？ | 能，且覆盖面从 2 个平台扩到 7 个 |
| 能不能直接当 `DataSourceAdapter` 用？ | **不能** —— 它是"任务控制面 + 落盘"，不是"同步查询面"，契约维度不同（需加归一化 sidecar） |
| 许可证允许吗？ | **不允许商用** —— `NON-COMMERCIAL LEARNING LICENSE 1.1`，需版权方书面同意 |
| ~~建议~~ | ~~不接本体~~ → **已改为：复用本体 + 独立只读 sidecar（`BM_MC_LICENSE_ACK` 显式确认后生效）** |

**一句话**：MC 的价值在**信息**（七平台各有哪些接口、各自的准入门槛），也在**代码**——
但用它的代码必须过两道闸：许可证（产品决策）与架构（collector 归一化层）。
粉丝画像仍然只能走商务（方案 D / L1）。

---

## 1. 先纠正一个定位问题：`extract_interfaces.py` 不是接入点

这是本次评估里最容易误解的一点。`interface_extract/extract_interfaces.py`（605 行）是一个
**AST 静态分析 + 文档生成工具**，不是运行时组件：

```
media_platform/<platform>/client.py
        │  ast.parse（静态读源码，不执行）
        ▼
  提取每个方法的：直接 HTTP 调用（self.get/post/request）、
  私有辅助函数递归展开出的真实 URI、同级公开方法调用（聚合）
        ▼
  interfaces.json（结构化） + INTERFACES.md（可读文档）
```

它**不取数、不联网、不登录**。运行它得到的是一份接口清单：

```bash
.venv/bin/python interface_extract/extract_interfaces.py
# [OK] 直接接口合计 61 个 → interface_extract/INTERFACES.md
```

所以"接入 `extract_interfaces.py`"这个动作本身无法让系统多拿到一个字节的数据。
它的正确用法是**喂给架构决策**：让我们能看清七平台的能力边界，回答
"哪个平台能提供哪个指标"。这个价值是真实的，我们采纳它（见 §6）。

真正会取数的是 `media_platform/` 下的七个客户端 + `api/` 那个 FastAPI 服务 —— 而这两者
各自有硬约束，见下。

---

## 2. 事实基础：MC 到底是什么

### 2.1 七平台与接口规模

| 平台 | 客户端类 | 域名 | 直接接口 | 聚合方法 | 业务枚举里有没有 |
|---|---|---:|---:|:---:|
| 小红书 `xhs` | `XiaoHongShuClient` | `edith.xiaohongshu.com` 等 4 个 | 8 | 4 | ✅ 已有 |
| 抖音 `dy` | `DouYinClient` | `www.douyin.com` | 6 | 3 | ✅ 已有 |
| 快手 `ks` | `KuaiShouClient` | `www.kuaishou.com/graphql` | 8 | 5 | ❌ 不在 |
| B站 `bili` | `BilibiliClient` | `api.bilibili.com` | 11 | 6 | ✅ 已有（**零真实数据**） |
| 微博 `wb` | `WeiboClient` | `m.weibo.cn` | 6 | 3 | ✅ 已有（**零真实数据**） |
| 贴吧 `tieba` | `BaiduTieBaClient` | `tieba.baidu.com` | 11 | 2 | ❌ 不在 |
| 知乎 `zhihu` | `ZhiHuClient` | `www.zhihu.com` / `zhuanlan.zhihu.com` | 11 | 5 | ❌ 不在 |

> "业务枚举里有没有"指 `packages/contracts/src/common.ts` 的 `POPULAR_PLATFORMS`
> = `["douyin","xiaohongshu","bilibili","weibo"]`。B站/微博在枚举里但**当前零真实数据**
> —— 这是本次评估里唯一真正值得跟进的一格。

### 2.2 服务面：`api/` 是一个**任务控制面**，不是查询面

| 路由 | 作用 |
|---|---|
| `POST /api/crawler/start` | 提交采集任务（platform / crawler_type / keywords / ids / save_option / cookies…） |
| `POST /api/crawler/stop` · `GET /status` · `GET /logs` | 控制与轮询 |
| `GET /api/data/files` · `/files/{path}` · `/stats` · `/download/{path}` | 读 `data/` 目录下已落盘的结果文件 |
| `WS /api/...` | 推日志 |

执行方式（`api/services/crawler_manager.py`）：

```python
self.process = subprocess.Popen(["uv", "run", "python", "main.py", ...])
```

**提交任务 → spawn 子进程 → 抓取 → 落盘 jsonl/csv → 读文件**，而且是**单进程串行**
（`CrawlerStartRequest` 起新任务时若已有进程在跑直接 400）。

这与 brandsale 的适配器契约是两个维度：

| | brandsale `DataSourceAdapter.fetch()` | MC `api/` |
|---|---|---|
| 调用语义 | 同步：给 query，拿 rows | 异步：提交任务，轮询状态，事后读文件 |
| 粒度 | 单次查询（一个 sec_user_id、一个关键词） | 一次任务（一个平台 + 一批关键词/ID，可跑几十分钟） |
| 并发 | 网关内并发多源 | 单任务串行，进程级互斥 |
| 输出 | 带 `Provenance{tier, synthetic, rowCount, note, asOf}` | 平台原始 payload 落盘 |
| 缓存/限流 | `withCache` + 令牌桶 + `maxCallsPerJob` | 无（进程外） |
| 闸门 | `scope → source → authz → tenant` 四项检查 | 无 |

结论：**MC 不能作为适配器被直接注册**。要用它，必须再写一层"任务提交 + 结果归一化 + 落库"
的桥，而这层桥才是真正的工作量与风险所在（我们上一次写 `douyin-web.ts` 404 行 +
`xiaohongshu.ts` 324 行，就是这层归一化）。

### 2.3 运行时依赖与准入门槛

依赖（`pyproject.toml`）：`httpx` + **`playwright>=1.61`** + `tenacity`。七个平台的签名
都必须靠浏览器环境生成，这一点已由 `interface_extract/TEST_REPORT.md` 的**无凭证在线探测**证实：

| 平台 | 探测项 | 无凭证结果 | 含义 |
|---|---|---|---|
| B站 | 登录态 nav | `-101 账号未登录` | 需登录 |
| 微博 | 登录态 / 配置 | 可直接访问 | **最开放** |
| 微博 | 搜索 getIndex | 302 重定向 | 需带 Cookie 跟随 |
| 知乎 | 登录态 / 搜索 | 401 / 400 | 需 `x-zse-96` 签名 |
| 贴吧 | PC sync / 搜索 | 可直接访问 | **最开放** |
| 小红书 | 搜索 / 登录态 | `-101` / `-1` | 需登录 + `x-s` 签名 |
| 抖音 | 评论列表 / 搜索 | 可直接访问 | 但需 `a_bogus` 才能拿到有内容的返回 |
| 快手 | GraphQL 详情 | `result=2` | 需登录 + `__NS_hxfalcon` 签名 |

七个签名/风控项：抖音 `a_bogus`、快手 `__NS_hxfalcon`、B站 `wbi`、小红书 `xhshow`、
知乎 `x-zse-96`（execjs + `libs/zhihu.js`）、贴吧 `_sign_pc_params` + `tbs`。

**这意味着**：采集必须跑在"有登录态 + 有浏览器 + 有账号池"的机器上。账号池是真正的瓶颈
与合规风险点——Cookie 约 7 天过期、可能触发验证码、激进调用会封 IP。这与我们此前给
小红书只读代理写的风控处置表是同一类问题，只是现在要乘七个平台。

---

## 3. 四条硬约束（按严重度排序）

### 🔴 P0-1　许可证禁止商用

```
NON-COMMERCIAL LEARNING LICENSE 1.1
CONDITIONS:
2. 本软件仅限用于学习和研究目的，不得用于大规模爬虫或对平台造成运营干扰的行为。
3. 未经版权所有者书面同意，不得将本软件用于任何商业用途或对第三方造成不当影响。
```

brandsale 是**商业品牌营销 AI 策略咨询系统**——报告会交付给甲方、结论会指导真实投放预算。
把 MC 的代码或数据接进生产链路，直接落在第 3 条禁止范围内。

这不是"加个声明就能规避"的问题：

- 它的产物（采集到的达人/作品/评论数据）会进入报告 → 报告是商业交付物 → 落入"用于商业用途"
- 即使只用作内部预研，**产出的数据一旦进入报告**，链条性质就变了

**唯一可行的用法**：在 dev/预研环境把它当研究工具跑，产出**只用于验证"接口是否可取到数据"**，
**绝不进入报告**（处理方式同已删除的 `datasource:lab`：假数据自己声明自己是假的）。

### 🔴 P0-2　架构错配：任务控制面 ≠ 同步查询适配器

见 §2.2。要接就得写"任务桥 + 归一化 + 产物入库"三层，且要解决：

- **单进程串行** → 与网关的多源并发取数模型冲突（一个 job 里 CI/CT 要同时问多个源）
- **无 provenance** → MC 产出原始 payload，`tier/synthetic/rowCount/note` 全要自己补
- **无闸门** → sidecar 必须把"来源身份"上交给 brandsale 的闸门，而不是自己决定

### 🟠 P1-1　运行时栈错配

brandsale：Node 22 + TS 单仓（npm workspaces）+ SQLite，一个有界依赖图（`check:boundaries` 强制）。
引入 MC 等于新增：Python 3.11 运行时 + Playwright + Chromium（数百 MB）+ 一套独立的
Cookie/身份池 + 一个常驻 HTTP 服务 + 一个落盘数据目录。**部署形态从"一个进程"变成"两个异构服务"**。

这不是不可接受（我们此前的小红书只读代理就是 sidecar），但必须有明确的收益来换。

### 🟠 P1-2　能力上限：补不了 P0-3

七平台在**内容层**覆盖很全，但**受众聚合画像（年龄/性别/地域占比）在公开 Web 接口层不存在**：

| 需求缺口 | xhs | dy | ks | bili | wb | tieba | zhihu |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 关键词搜索 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 内容详情 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 评论 / 子评论 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 创作者主页 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 创作者内容列表 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 粉丝 / 关注列表 | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **粉丝画像（年龄/性别/地域）** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 投流 / ROI 后台数据 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

值得注意：**B站是七平台里唯一暴露粉丝/关注列表的**（`get_creator_fans` /
`get_creator_followings`）——而 B站恰好也在 `POPULAR_PLATFORMS` 里。

评论 `ip_label`（IP 属地）仍是唯一的地域代理，但它是**有偏样本**（只有会评论的人才被统计），
口径与粉丝地域完全不同。这条红线此前已写进代码与工具描述，保持不变。

---

## 4. 移除 `douyin_web_public` / `xhs_web_public` 的理由

两条源本身**没有合规问题**（L3 只读、`synthetic: false`、不封装写能力）。移除的理由是
**收益与成本不成比例**，而不是它们错了：

1. **能力上限已到顶**。它们能给的只有「达人 + 内容 + 评论」——而 MC 的七平台评估证明，
   再往上扩到七个平台，仍然是同一层，**粉丝画像这一格谁也补不了**。
   留一条"看起来有平台数据"的窄通道，反而让报告更容易出现"有达人数据但无人群洞察"的
   半吊子结论，不如显式归零：报告里写"无平台数据"是**准确**的。
2. **维护面很大但价值窄**。两条适配器 728 行 + 四个工具 + 919 行测试/夹具 + 639 行联调脚本，
   换来的是"比 web_search 多拿到作品互动数与评论"——而这两项当前都没有进入报告的关键结论路径。
3. **替代方案已被证伪**。本轮评估的结论是：MC 不能接（许可证 + 架构）；
   那么"两条自研适配器 vs 七个平台的 MC"这个选择题就不存在了——
   在找到合规且架构匹配的通道之前，**平台内内容层整体搁置**比留半条腿更清晰。

移除清单（已完成）：

```
packages/datasource/src/douyin-web.ts        (404 行)  删除
packages/datasource/src/xiaohongshu.ts       (324 行)  删除
tests/douyin-style.test.ts                   (292 行)  删除
tests/xhs-proxy.test.ts                      (263 行)  删除
tests/fixtures/fake-xhs.mjs                  (136 行)  删除
scripts/datasource-lab.ts                    (639 行)  删除
douyin_creator / douyin_comments / xhs_creator / xhs_note（4 个工具）删除
config.douyin / config.xiaohongshu + DOUYIN_* / BM_XHS_* 全部配置项  删除
```

**不变量没有被削弱**：原 `datasource-adapters.test.ts` 里真正有价值的三条安全断言
（绑定来源不被参数带偏、未配置即不注册、工具清单无写能力）已**等价迁移**到
`tests/web-search.test.ts`，继续对唯一外部源生效。

---

## 5. 如果一定要接：四个方案

| | 方案 | 能拿到 | 成本 | 合规 | 状态 |
|---|---|---|---|---|---|
| **A** | 不接，归档接口清单做能力地图 | 无新数据 | 0 | ✅ | 已执行（清单仍作能力地图，见 §6） |
| **B** | 复用 MC 本体作**独立只读 sidecar**，加一层归一化 | 内容层（内容/评论/创作者）× 7 平台 | 中（一层归一化 + 运维） | ⚠️ **需版权方同意或明确接受风险** | ✅ **本次采纳并已落地** |
| **C** | 自研七平台只读 sidecar（不复用 MC 代码） | 内容层 | 高（七套签名 + 账号池 + 归一化） | ✅ 可控 | 未采纳；若将来要摆脱许可风险，这是替换路径 |
| **D** | 买 L4 授权数据源（星图/蒲公英类第三方） | **粉丝画像 + 报价 + 商单转化** | 中（商务 + 法务双开关） | ✅ | ✅ **真正解 P0-3 的那条，仍待推进** |

**实际采纳的是方案 B**，形态与方案 C 的接口边界设计**完全一致**（只读路由表、错误码归一化），
只是采集内核换成了现成的 MC：

```
已落地      B：MC 本体（不改源码、不分发）→ apps/collector（只读归一化 + 缓存）
              → 七个 L3 适配器 → 七个平台工具
              生效条件：BM_MC_ENABLED + BM_MC_LICENSE_ACK + BM_MC_COLLECTOR_URL
解 P0-3     D + 抖音开放平台 fans_data（L1）：两条都是商务先行、代码后置
可选替换     C：若将来需要彻底摆脱非商用许可，把 collector 背后的 MC 换成自研采集内核，
              接口契约（§下面的只读路由表）原样保留即可 —— 这也是当初先把边界设计成
              "路由表即能力边界"的好处
```

### 方案 C 的 sidecar 契约（供将来实现时参照）

与我们此前给小红书只读代理划的边界完全同构——**只读子命令白名单写在路由表上**，
写命令根本不存在于路由表里（而不是靠一个布尔开关守）：

```
# 只读，且路径即能力边界
GET {baseUrl}/bili/creator?mid=<mid>
GET {baseUrl}/bili/creator-videos?mid=<mid>&count=20
GET {baseUrl}/bili/video?bvid=<bvid>
GET {baseUrl}/bili/comments?bvid=<bvid>&all=true
GET {baseUrl}/bili/creator-fans?mid=<mid>&count=20      # 七平台里唯一有的一格

# `post` / `delete` / `like` / `comment` / `follow` 等写命令不在路由表内

成功:  { "ok": true,  "meta": {"via":"...","fetchedAt":"..."}, "data": {...} }
失败:  { "ok": false, "error": { "code": "<闭合码集>", "message": "..." } }
```

两条硬要求（沿用既有教训）：

1. **错误码必须归一化成闭合集**，且每个码对应一句可执行处置
   （"需重新登录" / "触发验证码，需人工处理" / "出口 IP 被限流" / "代理未就绪"）。
   只报"接口不可用"等于把排查成本推给运营。
2. **代理未就绪走 5xx，平台侧业务失败走 200**；适配器先解析响应体再判状态码，
   否则 503 会被压成一句"代理 HTTP 503"，处置表白写。

适配器侧照旧：`tier: "L3"`、`synthetic: false`、`note` 明写"未经人工核验"、
`boundSourceId` 绑死来源、`maxCallsPerJob` 兜住账号池额度，并走
`seed.ts BUILTIN_SOURCES` 登记 + `grantAuthz` 授权。

---

## 6. 采纳动作：把接口清单当能力地图用

`interface_extract/{interfaces.json, INTERFACES.md, TEST_REPORT.md}` 是**可再生**的资产，
建议纳入需求对齐流程：

1. **能力盘点**（已做）：七平台 × 指标 → 见 §3 的覆盖表。以后每次需求出现新的数据缺口，
   先查这张表能回答"哪条通道可能供得上"。
2. **门槛预判**：`TEST_REPORT.md` 的无凭证探测结论可直接回答"这条路要不要登录态"，
   用来在写代码前判断成本量级。
3. **回归**：MC 上游更新后重跑 `extract_interfaces.py` + `run_interface_tests.py`，
   就能看出版本漂移（新增/消失的端点）。这是"评估外部采集项目"的可复用方法。

> 归档位置建议：`docs/references/mediacrawler-interfaces.md`（本文档只引用结论，
> 原始清单不复制进本仓库——它是第三方项目的产物，且非商用许可，复制进来没有必要）。

---

## 7. 遗留缺口（主动说明）

1. **P0-3 粉丝画像依然无解**，且本轮评估再次确认：短视频/图文平台的公开 Web 接口层
   不存在受众聚合画像。正道只有抖音开放平台 `fans_data`（L1，需企业主体 + 权限审核 + 达人 OAuth）
   或 L4 授权数据服务。**商务先行，代码后置。**
2. **B站/微博此前在业务枚举里但零真实数据** —— 本轮已补上内容层采集
   （`mc_bili` / `mc_wb`），但**粉丝列表仍然拿不到**：`media_platform/bilibili/core.py` 里
   `get_fans` / `get_followings` 的调用是**注释掉的**，CLI 与 FastAPI 都没有开关触发它。
   所以 `creator_fans` 没有成为算子（见 `packages/config` 的 `CollectOp` 注释）。
   若确有该需求，只有两条路：改 MC 源码开放开关（与"不改其源码"的约定冲突），或自研（方案 C）。
3. **`TIER_LABEL.L3` 的文案与实际不符**。它写着"公开指数与人工核验"，
   而公开采集/检索只有前半段。修文案会影响报告页与前端展示，属于独立议题
   （与上一轮留下的同一项）。
4. **MC 的评估结论有时效性**。接口清单来自 `media_platform/*/client.py` 的静态解析，
   平台改版后清单会失真；MC 仓库自身的维护活跃度也需要复核。
5. **`interface_extract/` 目录属于 MC 仓库，不在本项目版本控制内**。
   本文档记录了方法（怎么重新生成），但不持有产物。
