# 历史成功跑批案例清单

数据来源：`.data/brandsale.sqlite`（截至 2026-10-26 17:45，`jobs` 42 条 / `job_phases` 252 条 / `artifacts` 322 条）。

## 一、先定口径：`status = succeeded` 不等于"真跑通"

库里有 42 个任务，`status=succeeded` 有 21 个，但直接拿来当案例会踩三个坑，所以先按三条过滤：

| 过滤项 | 判据 | 剔掉了什么 |
|-|-|-|
| **不是冒烟任务** | 单个阶段耗时 > 1 秒 | 10 个"每阶段 2ms"的 e2e 测试任务（2026-10-05 ~ 10-08），`succeeded` 但模型根本没跑 |
| **不是兜底合成** | `report_dsl.meta.degraded` 为空 | 5 个 `succeeded` 但报告由 `synthReport` 模板拼出来的（模型超时 / 输出被 max_tokens 截断） |
| **产物齐全** | 9 类产物都在（brief / intel / intel_evidence / creator_candidates / playbook / budget / report_dsl / report_html / report_markdown） | `partial` 里产物不足的 |

**关键点**：`status` 只看流水线有没有走完，不看报告是不是模型写的。`job_0mvgevzodc`（羽绒服 08:18 那次）状态是 `succeeded`，报告其实来自兜底模板——这类如果拿去给客户看，一眼就能看出是空话。

## 二、真正跑通的 6 个案例

按时间倒序。`CLEAN` = 报告由模型生成 + 六阶段全绿 + 无降级标注。

| # | 任务 | 时间 | 行业 / 类目 | 预算 | 平台 | 时长 | 页数 | 报告 |
|-|-|-|-|-|-|-|-|-|
| 1 | `job_0mvhcp86x1762dsrrhp` | 10-21 00:05 | 服饰鞋包 / 保暖内衣 | 100 万 | 小红书+抖音 | **29 min**（无空转） | 14 | CLEAN |
| 2 | `job_0mvgany95k7poz73mks` | 10-20 06:20 | 服饰 / 羽绒服 | 200 万 | 小红书+抖音 | **37 min**（无空转） | 14 | CLEAN |
| 3 | `job_0mv9k0wvg8vvpwmqd9y` | 10-15 13:08 | 两轮出行 / 电动车 | 300 万 | 抖音+小红书+B站 | 3623 min（跨 2.5 天，见下） | 14 | CLEAN |
| 4 | `job_0mv7ykg0zd28s6vzcyo` | 10-14 10:19 | 3C数码 / 耳机 | 200 万 | 抖音+小红书+B站 | 143 min（空转 126） | 14 | CLEAN |
| 5 | `job_0mv5ydf69a7aio1uhfd` | 10-13 00:38 | 美妆个护 / 精华 | 200 万 | 小红书+抖音 | 336 min（空转 324） | 16 | CLEAN |
| 6 | `job_0muwlik8achr67h90g3` | 10-06 11:28 | 美妆 / 精华 | 300 万 | 抖音+小红书 | **11 min**（无空转） | 8 | CLEAN（早期版本） |

**只有 1、2、6 是"连续跑完"的**（阶段耗时之和 ≈ 墙钟时间）。3、4、5 的墙钟时长里 90% 以上是空转——等采集器配额、等网关重启，不是模型在算。要做时长演示，用 1 或 2。

### 可复现的 brief 原文

**① 保暖内衣（推荐首选，最新且最干净）**
```json
{"industry":"服饰鞋包","category":"保暖内衣","brandIds":["蕉内","ubras","优衣库","猫人","恒源祥","红豆"],"budget":{"currency":"CNY","amount":1000000},"objectiveWeights":{"awareness":0.4,"conversion":0.45,"retention":0.15},"window":{"from":"2026-10-21","to":"2026-11-11"},"platforms":["xiaohongshu","douyin"],"notes":"双十一大促：预算 100 万，小红书种草 + 抖音直播/商城闭环。主力价位 79-220 元中端功能款（自发热、无痕、加绒），主推自发热打底套装与加厚保暖两件套。本轮不指定自有品牌，做市场与竞品调研。"}
```

**② 羽绒服**
```json
{"industry":"服饰","category":"羽绒服","brandIds":["波司登","鸭鸭","高梵","雪中飞","坦博尔","雅鹿"],"budget":{"currency":"CNY","amount":2000000},"objectiveWeights":{"awareness":0.35,"conversion":0.5,"retention":0.15},"window":{"from":"2026-10-20","to":"2026-11-11"},"platforms":["xiaohongshu","douyin"],"notes":"双十一大促：预算 200 万，小红书种草 + 抖音直播/商城闭环。主推中高端鹅绒长款与轻薄排骨款。"}
```

**③ 两轮电动车（唯一指定了三平台 + 不做自有品牌）**
```json
{"industry":"两轮出行","category":"电动车","brandIds":["雅迪","爱玛","台铃","九号","小牛","绿源"],"budget":{"currency":"CNY","amount":3000000},"objectiveWeights":{"awareness":0.5,"conversion":0.4,"retention":0.1},"window":{"from":"2026-10-01","to":"2026-12-31"},"platforms":["douyin","xiaohongshu","bilibili"],"notes":"Q4 投放，总预算 300 万，品效并重。本轮未指定自有品牌，只做市场与竞品调研。"}
```

**④ 耳机**
```json
{"industry":"3C数码","category":"耳机","brandIds":["索尼","Bose","华为","小米"],"budget":{"currency":"CNY","amount":2000000},"objectiveWeights":{"awareness":0.667,"conversion":0.333,"retention":0},"window":{"from":"2026-10-01","to":"2026-12-31"},"platforms":["douyin","xiaohongshu","bilibili"],"notes":"四个耳机品牌，抖音/小红书/B站投放，总预算 200 万，既要打响声量也要抓转化"}
```

**⑤ 精华（雅诗兰黛 / 资生堂）**
```json
{"industry":"美妆个护","category":"护肤品-精华","brandIds":["雅诗兰黛","资生堂"],"budget":{"currency":"CNY","amount":2000000},"objectiveWeights":{"awareness":0.3,"conversion":0.5,"retention":0.2},"window":{"from":"2026-11-01","to":"2026-11-11"},"platforms":["xiaohongshu","douyin"],"notes":"双十一小红书+抖音，预算 200 万"}
```

### 复现命令

```bash
curl -s -X POST http://127.0.0.1:8787/api/v1/jobs \
  -H 'Authorization: Bearer t.tenant_demo.u_demo' \
  -H "Idempotency-Key: rerun-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"spec":{"brief":<上面任一 brief>}}'
```
`brief.brandIds` 必须显式传（`brief/parse` 不抽这个字段）。不指定自有品牌时不要传 `ownBrandId`，否则会多出「品牌自诊概览 + 差距矩阵」两页。

## 三、`succeeded` 但实为兜底合成 —— 不要当案例

| 任务 | 时间 | 类目 | 降级原因 |
|-|-|-|-|
| `job_0mvgevzodccs9fb6gdh` | 10-20 08:18 | 羽绒服 | 模型调用超时（E-AGENT-002）→ 模板合成 |
| `job_0mv7xmn4gbs2yqyemwi` | 10-14 09:53 | headphones（**英文 category，7 平台搜不到数据**） | 模型 fetch failed → 模板合成 |
| `job_0mv6e6ffw0tz218juj4` | 10-13 08:01 | 护肤品-精华 | 模型输出被 max_tokens 截断 → 模板合成 |
| `job_0mv3k29o9howch18nry` | 10-11 08:22 | 精华 | 模型 300s 无响应 → 模板合成 |
| `job_0mv3f2gmwgit1llkles` | 10-11 06:02 | 护肤品-精华 | 模型 180s 无响应 → 模板合成 |

注意 `job_0mvgevzodc` 与 `job_0mvgany95k` 是**同一个 brief 连跑两次**：06:20 那次模型正常（CLEAN），08:18 重跑撞上超时退化为模板。同一份输入能出两种质量，这是"success 率"最真实的写照，也是 P0 修复回路的动机。

## 四、`partial` 但报告是模型真写的

这些流水线标了降级，报告内容仍是模型生成，只是被判了深度/引用问题，共 8 个：
`job_0mv86by83i`（电脑）、`job_0mv84aogdn`（手机）、`job_0mv3x4h790`（精华多品牌）、`job_0mv3naqbof`（精华）、`job_0mv3i6dq6v`（精华）、`job_0mv3get6pe`（护肤品-精华）、`job_0muzbfce91`（精华）、`job_0muy3dmev8`（精华）。
其中 `job_0mv3get6pe` 是**唯一产出过「品牌自诊 + 差距矩阵」**的任务（指定了 `ownBrandId`），要演示自有品牌视角用这个。

## 五、全库分布（对账用）

| 状态 | 报告来源 | 类型 | 数量 |
|-|-|-|-|
| succeeded | 模型生成 | 真实跑批 | **6** ← 可作案例 |
| succeeded | 兜底模板 | 真实跑批 | 5 ← 不可作案例 |
| succeeded | 模型生成 | 冒烟（每阶段 2ms） | 10 |
| partial | 模型生成 | 真实跑批 | 8 |
| partial | 兜底模板 | 真实跑批 | 7 |
| cancelled / 无 report_dsl | — | — | 6 |

## 六、已导出到本地的样张

`out/sample-reports/`（不进版本库，`.gitignore` 已排除 `out/`）：

| 文件 | 内容 |
|-|-|
| `2026-10-21_保暖内衣.html / .md / .json` | 首选样张，自包含 HTML，14 页 |
| `2026-10-20_羽绒服.*` | 同期第二个大促类目 |
| `2026-10-15_两轮电动车.*` | 唯一三平台（抖音+小红书+B站）案例 |
| `2026-10-14_耳机.*` | 3C 品类 |
| `2026-10-13_精华_雅诗兰黛资生堂.*` | 16 页、指定双品牌 |

HTML 内联全部样式，无外部依赖，可直接浏览器打开或打印 PDF。

## 七、这批案例暴露的已知问题（选案例时要避开）

1. **保暖内衣那次小红书 0 条**：报告 22 条证据全来自抖音，第 7 页人选表 5 人全是抖音账号，小红书 38 万预算"无已验证执行主体"。这是采集时序缺口（报告先于采集完成），不是模型编的——报告自己写明了。给客户演示时这条会被追问。
2. **粉丝量 3/5 未采集**：`pfcre_` 开头的内部聚合 id 还在人选表里出现（那几个账号没补采到主页资料）。
3. **报价一律"未采集"**：`pricing_query` 对全部候选返回 `E-DATA-002`，成本口径完全缺失，ROI 是模型推演值。
4. **早期任务（10-06 ~ 10-08）页数只有 8**，未达现行深度策略的 12 页下限，别当"标准产出"看。
