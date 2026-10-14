# collector-core · 内嵌采集内核

本目录是 **MediaCrawler 采集内核在 brandsale 仓库内的内嵌副本**。七个平台
（小红书 / 抖音 / 快手 / B站 / 微博 / 贴吧 / 知乎）的公开内容采集与扫码登录都在这里。

> ⚠️ **许可证：上游为非商用许可。**
> 上游 `MediaCrawler` 使用 `NON-COMMERCIAL LEARNING LICENSE 1.1`，条件第 3 条禁止
> 未经版权方书面同意的任何商业用途，原文见本目录 [`LICENSE`](./LICENSE)。
> 把它内嵌进 brandsale（一个商业交付系统）是本项目的**显式决策**，对应开关
> `BM_MC_LICENSE_ACK=true` —— 未显式确认时，七个平台适配器与七个工具**整体不装配**，
> 报告会如实写「无平台数据」。这是把「引入非商用组件」固化成一次显式决策，而不是
> 藏在某次配置里的副作用。

## 来源

| | |
|---|---|
| 上游仓库 | `https://github.com/NanmiCoder/MediaCrawler.git` |
| 引入版本 | commit `e9dd17a16338c3915f2335bc609383d316e055f2`（2026-10-09） |
| 上游版本号 | `0.1.0` |
| 引入方式 | 源码内嵌（vendor）。**不是** submodule，**不是** pip 包依赖 |

## ⚠️ 一个必须先知道的能力约束：上游「教学版」不采集用户个人信息

本内核来自上游的**教学版**（见上游 commit `9f4f8bf refactor: 教学版移除全平台用户个人信息采集与持久化`），
它刻意**不采集、不落盘任何可定位到真人的信息**。实测确认（七个平台逐一看过）：

| 项 | 现状 |
|---|---|
| 原始用户 ID | 不落盘。只写 `creator_hash = sha256(uid)[:16]`（见 `tools/user_hash.py`） |
| 昵称 | **完整保留**（brandsale 改造：默认不再打码；设 `BM_MC_MASK_NICKNAME=true` 可退回上游的中间脱敏 `张***三`） |
| 头像 / 主页链接 / 性别 / 签名 / IP 归属地 | 一律不采集 |
| 粉丝数等账号指标 | 不采集 |
| `store/*/save_creator()` | xhs / douyin / kuaishou / weibo / tieba 是 **`return` 空操作**；zhihu 有 wrapper 但委托的 `store_creator` 是 `pass`；bilibili 的 class 方法可写、但 core 不调用。**结论：七个平台都不落创作者资料**（实测落盘目录无任何 `creators_*.jsonl`） |

由此带来两条**产品级后果**，改产品时必须知道：

1. **`creator` 算子产出的是「该账号名下的**作品**」，不是「该账号的资料页」** ——
   七个平台**都拿不到创作者资料**（粉丝数 / 简介 / 性别 / 地域 / 头像），
   `kind=creator` 记录七个平台**一个都产不出来**（知乎也不产：`store/zhihu/_store_impl.py:store_creator`
   是 `pass`，且 `media_platform/zhihu/core.py` 根本不调用 `save_creator`）。
   别按"能拿到达人主页/粉丝量"去设计。
2. **`creator` 算子的入参 `creatorId` 必须是平台原始 UID**（一般是数字），
   而产品内归一化输出里的 `authorId` 是 `creator_hash`，**喂回去必然失败**
   （微博实测：`DataFetchError: 这里还没有内容`）。也就是说 `creator` 只能由外部手工提供原始 ID，
   不能由链路自身的数据驱动。

这不是本仓库改动引入的，也不是 bug —— 是上游刻意的取舍。若要恢复创作者资料采集，
需要显式修改 `tools/user_hash.py` 与各 `store/*/__init__.py`，并重新评估合规口径。

## 相对上游做了什么

**只搬「采集内核」，不搬外围。** 上游仓库里与本项目无关的部分没有搬进来：

| 未引入 | 原因 |
|---|---|
| `webui/` | 上游自带的 Web 控制台；brandsale 有自己的编排层 |
| `api/` | FastAPI 控制面（起任务 → spawn 子进程 → 落盘 → 读文件）；`apps/collector` 直接驱动内核，不需要这层 HTTP |
| `database/` | 多数据库 ORM（MySQL / SQLite / MongoDB / Postgres）；brandsale 用自己的 storage 层 |
| `docs/`、`interface_extract/`、`test/`、`tests/` | 文档与测试，不属于运行内核 |
| `main.py`、`cmd_arg/` | 交互式 Typer CLI，由 [`run.py`](./run.py) 取代 |
| `README*.md`、`package.json`、`uv.lock`、`.github/`、`.pre-commit-config.yaml` | 仓库元数据 |

**代码级裁剪**（改动过的文件，其余原样）：

| 文件 | 改动 |
|---|---|
| `store/*/_store_impl.py`（7 个） | 只保留 `*JsonStoreImplement` / `*JsonlStoreImplement`；删除 CSV / DB / SQLite / MongoDB / Excel 实现（它们依赖已移除的 `database/` 与 sqlalchemy / openpyxl） |
| `store/*/__init__.py`（7 个） | `STORES` 映射收窄为 `{"json", "jsonl"}` |
| `store/excel_store_base.py` | 删除 |
| `var.py` | 去掉 `import aiomysql` 与全仓无人引用的 `db_conn_pool_var` |
| `config/db_config.py` | 数据库连接配置整体移除，只保留登录缓存需要的 `CACHE_TYPE_MEMORY` / `CACHE_TYPE_REDIS` |
| `tools/async_file_writer.py` | `tools.words`（jieba / matplotlib / wordcloud）改为**按需导入**，词云默认关闭 |
| `media_platform/bilibili/core.py` | 用标准库替换唯一的 `pandas.date_range` 用法 |
| `media_platform/bilibili/{help,core}.py` | `parse_video_info_from_url` 补 `av` 号与**裸 aid** 两种形式，`get_specified_videos` 按 `isdigit()` 分流到详情接口的 `aid` / `bvid` 参数位（见下） |
| `media_platform/{xhs,douyin,kuaishou,bilibili,weibo,zhihu}/core.py` | 首页/落地页导航统一补 `wait_until="domcontentloaded"` + `timeout=60000`（见下） |
| `media_platform/tieba/login.py` | 登录入口选择器随贴吧改版失效 → 改为「短超时探测 + 新旧选择器都试 + 不再 `sys.exit()`」（见下） |
| `tools/crawler_util.py` | `find_login_qrcode` 增加 `timeout_ms` 入参（默认不变），供贴吧做短超时探测 |
| `run.py` | **新增**，内核薄入口（见下）；`--specified-id` 入口处对贴吧 / 微博做 ID 归一（见下） |

**为什么改页面导航**：上游这五处用的是 `goto(url)` 默认的 `wait_until="load"`——要等
**所有子资源**（含首页预加载的视频/大图）加载完。抖音首页媒体极重，实测 30s 默认超时打不满，
任务在"打开首页"这一步就失败。改成 `domcontentloaded`（DOM 就绪即返回）并放宽到 60s；
登录框、搜索结果等后续步骤本来就各自 `wait_for_selector` 等具体元素，不会因此漏状态。
贴吧、知乎上游已用 `domcontentloaded`，本次只补了缺失的 `timeout`。

**为什么改 B 站视频 ID 解析**：上游 `parse_video_info_from_url` 只认 BV 号（尽管注释写着
"Match /video/BV... or /video/av..."，`av` 分支其实不存在）。但 B 站**搜索结果的落盘字段里
根本没有 BV 号** —— `store/bilibili/__init__.py:update_bilibili_video` 只写
`video_id = str(View.aid)`，url 也是 `https://www.bilibili.com/video/av<aid>`。
于是"搜索拿到 id/url → 喂回 detail / comments 算子"这条闭环会直接
`ValueError: Unable to parse video ID`（真机跑 detail 时暴露）。
现补 `av` 号与裸 aid 两种形式；详情接口 `aid` / `bvid` 二选一，故 `get_specified_videos`
按 `isdigit()` 分流到对应参数位。三种输入（BV 号 / av 链接 / 裸 aid）均已实测跑通。

**为什么在 run.py 归一微博 note_id**：微博详情接口是 `{host}/detail/{id}` 直接拼串，
`--specified-id` 必须给**纯 note_id**。而产品内归一化输出的 `url` 恰好是
`https://m.weibo.cn/detail/<note_id>`——原样传进去会拼成
`.../detail/https://m.weibo.cn/detail/<id>`，微博回 404 页面，结果是
**exit 0 + 0 条记录**（伪装成"这条没数据"）。故在薄入口把 `m.weibo.cn/detail/<id>`、
`/status(es)/<id>`、`weibo.com/<uid>/<mid>` 三种形态收敛回纯 id。
放在 `run.py` 而非内核 client，是因为内核没有对应的 URL 解析入口，
而 `run.py` 本来就是"把产品侧入参翻译成内核入参"的那一层（贴吧的 `/p/<id>` 同理）。

**为什么改贴吧登录流程**：真机跑贴吧时整条链路硬失败。上游 `tieba/login.py:login_by_qrcode`
的逻辑是「先在首页找二维码 → 找不到就点 `//li[@class='u_login']` → 再找不到就 `sys.exit()`」。
但贴吧已改版：首页**不再自动弹登录框**，且登录入口从 `li.u_login` 变成了带「登录」文字的
`div.login-btn` —— 于是点按钮 30 秒超时，随后 `sys.exit()` 抛 `SystemExit`（**不被任何
`except Exception` 捕获**），子进程直接死、日志只剩一坨 traceback，上层只能给一句"未登录"
的猜测（用 `lastKernelError()` 才定位到失败的选择器）。

现改为：

1. 二维码探测用 **5s 短超时**（新增 `find_login_qrcode(timeout_ms=...)`），不在"确认没有"上白等 30s；
2. 登录入口**新旧选择器都试**（`div.login-btn` → `li.u_login`），命中即停；
3. 取码前等 `img.tang-pass-qrcode-img` 的 `src` 变成 `passport.baidu.com/v2/api/qrcode` ——
   弹窗里的 `<img>` 会先挂 `loading.gif` 占位，直接取会拿到加载图（真机踩过）；
4. 最终仍找不到码时**不再 `sys.exit()`**，改为提示"请在浏览器窗口内手动完成登录"并继续轮询
   登录态（等待 600s）；登录超时也由 `SystemExit` 改为带原因的 `RuntimeError`。

弹窗内的二维码选择器 `tang-pass-qrcode-img` 本身**没有失效**（截图确认「APP扫码登录」标签下是
真码），失效的只是「怎么把弹窗点出来」这一步。回归测试见 `tests/collector.test.ts`
（用 Python AST 断言真实 `sys.exit` 调用数为 0，并钉住 `timeout_ms` 入参；
拿上游同文件跑探针得 2 处，确认断言有牙齿）。


**未做任何改动**：`media_platform/**` 的其余全部（各平台 `client` / `field` / `media` /
`exception`、除贴吧外的各平台 `login.py`、快手与抖音的 `help.py`、B站 `help.py` 除 ID 解析外的
部分、快手的 `graphql/*.graphql`）、`libs/*.js`（抖音 `a_bogus`、
知乎 `x-se-96` 签名 JS 与 `stealth.min.js`）、`tools/` 除 `crawler_util.py:find_login_qrcode`
外的全部、`proxy/`、`cache/`、`model/`、`constant/`、`media_downloader/`。

> 说明：上游这一版的 `tools/user_hash.py` 自带 `anonymize_user_id` / `mask_nickname`。
> brandsale 的改造点：**昵称默认完整保留、不再打码**（业主明确要求报告里的人选/账号完整显示），
> 需要时可用 `BM_MC_MASK_NICKNAME=true` 恢复脱敏；`anonymize_user_id`（`creator_hash`）**保持不变**
> ——它只作分组键，不参与账号展示，且不落原始 uid。
> 另：`save_creator` 在 xhs/dy/ks/wb/tieba 是空实现、zhihu/bilibili 的落盘路径写不出 creator
> （见本文件顶部「能力约束」）。

### run.py 为什么必须存在

上游的启动链路是 `main.py` + `cmd_arg/arg.py`（Typer CLI）+ `database` / `excel` 落盘。
本仓库不需要交互式 CLI、也没有那两块依赖，所以用一个薄入口 `run.py` 取代：

- 参数 → `config` 模块常量的映射**照抄上游 `cmd_arg/arg.py`**（含 detail/creator 模式
  的平台专属 ID 列表变量名），保证行为与原生 CLI 一致；
- 固定 `SAVE_DATA_OPTION=jsonl`、`ENABLE_GET_MEDIA=False`、`ENABLE_GET_WORDCLOUD=False`；
- `--cdp` 是三态 `auto|true|false`，**默认 auto**：本机有 Chrome/Edge 就直接驱动它
  （隔离 profile），省掉 150MB 的 playwright chromium 下载；都没有才退回 chromium。
  上游的 `CDP_CONNECT_EXISTING=True` 也改成 `False`——那个默认值要求用户手工去
  `chrome://inspect` 打开远程调试，对"被程序调用"的场景不可用，改成内核自己拉起独立浏览器。

## 怎么跑

由 `apps/collector`（Node sidecar）驱动，日常不需要手工调用本目录。
手工排障时：

```bash
# 1) 一次性环境准备（建 venv + 装依赖 + 下载 chromium）
bash services/collector-core/setup.sh

# 2) 手工跑一次采集（首次会开浏览器窗口扫码登录）
./services/collector-core/.venv/bin/python services/collector-core/run.py \
  --platform xhs --type search --keywords 护肤 --max-notes 20 \
  --save-path ./services/collector-core/data
```

结果落在 `<save-path>/<平台名>/<type>_<contents|comments>_<日期>.jsonl`。

`--platform` 取值：`xhs` `dy` `ks` `bili` `wb` `tieba` `zhihu`；
`--type` 取值：`search`（关键词）/ `detail`（按 ID/URL 取内容，可带评论）/ `creator`（创作者**名下的作品**，非资料页）。

## 运行依赖

见 [`requirements.txt`](./requirements.txt)。`pyexecjs`（抖音 `a_bogus`、知乎 `x-zse-96` 签名）
需要机器上有可用的 JS 运行时 —— brandsale 本身就是 Node 项目，直接复用，无需另装。

## 运行时目录（已被 `.gitignore` 排除）

| 目录 | 内容 |
|---|---|
| `.venv/` | Python 虚拟环境 |
| `data/<平台目录>/jsonl/` | 采集落盘的 jsonl |
| `*_user_data_dir/` | 各平台的浏览器 profile 与登录态（**含 Cookie**） |
| `__pycache__/` | Python 字节码缓存 |

⚠️ **平台目录名由各平台 store 内部硬编码**（`store/*/_store_impl.py` 里传给
`AsyncFileWriter` 的 `platform=`），**不等于** brandsale 侧的平台短码：
`bili→bili`、`dy→douyin`、`ks→kuaishou`、`wb→weibo`，其余同名。
collector 正是按这个目录名去找 jsonl，两边不一致时采集**成功**却读不到任何记录
（B站踩过一次：表里写 `bilibili`、内核写 `bili`）。
`tests/collector.test.ts` 已用「从本目录源码读 `platform=` 字面量」的契约测试钉死，
改这里记得同步 brandsale 侧的 `MEDIA_CRAWLER_PLATFORM_META[*].dataDirName`。

## 与上游同步

本副本是一次性 vendor。上游若修了某个平台的签名或接口，需要手工把对应
`media_platform/<平台>/` 下的文件覆盖过来 —— 因为是副本，`git` 不会自动提示差异。
同步后请对照上文的「代码级裁剪」表，确认裁剪点没有在上游侧被重新引入。
