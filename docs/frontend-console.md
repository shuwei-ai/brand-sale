# 前端控制台（React + Ant Design）工程化说明

> 2026-10-10 起，控制台从「网关里的一段内联 HTML 字符串」重构为独立可构建的
> React 应用。本文说明边界、关键取舍与扩展方式。

## 1. 形态与目录

```
apps/web/                     React 18 + Ant Design 5 + Vite + TypeScript
  vite.config.ts              构建配置（契约别名、/api 代理、分包）
  src/
    main.tsx                  入口：ConfigProvider(zhCN) + 主题 + antd App 上下文
    App.tsx                   HashRouter 路由表
    theme.ts                  AntD 主题令牌 + 状态→颜色/文案的唯一映射
    styles.css                仅放"组件库表达不了"的全局样式（毛玻璃顶栏、终端等）
    api/
      session.ts              会话令牌（模块级可订阅 store）
      client.ts               统一 fetch + Bearer + ApiError 归一化
      endpoints.ts            全部接口清单（页面只调 api.xxx()）
      types.ts                返回类型（能复用契约包的一律复用）
    hooks/
      useAsync.ts             取数（竞态/卸载安全）+ 轮询
      useJobStream.ts         SSE：分帧解析、断线续传、rAF 合帧
    components/               AppShell / PhaseBoard / LiveConsole / EventTerminal /
                              ReportPreview / ArtifactPanel / StatusTag / HealthBadge / TokenBox
    pages/                    NewJobPage / JobListPage / JobDetailPage /
                              KnowledgePage / GovernancePage
```

**网关侧**：`apps/gateway/src/static.ts` 托管 `apps/web/dist`（路径穿越守卫、
MIME、缓存策略），`server.ts` 按「先产物、后内置控制台」的顺序回退。

## 2. 六个关键取舍（为什么这么做）

1. **前端只依赖 `packages/contracts`**。
   契约包是纯类型 + 纯常量、零 node 依赖，可以被浏览器打包。`API_PREFIX`、
   `PHASE_ORDER/PHASE_LABEL`、`KB_COLLECTIONS/KB_LABEL`、`POPULAR_PLATFORMS`、
   全部事件与记录类型都从同一处来——后端加阶段时前端要么编译报错、要么自动跟上，
   不存在"两处各写一份然后漂移"。`apps/*` 属应用层，`check:boundaries` 明确放行。
   反例：**不要**在前端 import `@brandsale/agent-pack`（会把 pi-agent-core 拖进浏览器包），
   所以 `BriefParseResult` 在 `api/types.ts` 里本地镜像并注明真相源。

2. **HashRouter，不用 BrowserRouter**。
   生产环境前端由网关同端口托管：`/` 吐 index.html、`/assets/*` 吐静态资源。
   History 路由要求网关对所有未知路径兜底回 index.html，会把真正的 404（比如
   打错的 API 路径）也吞掉。hash 路由让服务端永远只需处理这两个前缀。

3. **SSE 用 fetch + ReadableStream，不用 EventSource**。
   EventSource 不能带自定义请求头，用它就必须把 Bearer token 塞进 URL
   （进访问日志与 Referer）。`useJobStream` 自己分帧解析，断线 3 秒重连并带
   `Last-Event-ID` 只补缺口；收到 `view.snapshot` 时重拉任务详情。

4. **流式增量不逐条 setState**。
   一次真实任务 ≈1.6 万条 `agent.delta`。增量写进 ref，`requestAnimationFrame`
   合帧，每帧最多一次渲染；Live/Log 各自封顶（24 条 / 400 条）。
   服务端侧是三件事配套的：delta 在产出端**合帧**（`DeltaPump`，~120ms / ~160 字符，
   三条策略路径都会发）；事件缓冲**按类型分桶**（状态类 `EVENT_BUFFER_SIZE`、
   delta 单独一档 `DELTA_BUFFER_SIZE`）；**全量回放不回放 `agent.delta`**
   —— 刷新/新开页面只补状态类事件，流式正文从当前时刻重新开始，事件日志里会显式说明。

5. **鉴权边界不让步**。
   页面本身公开（不含业务数据），所有 API 带 Bearer；报告预览是
   「带 token fetch → blob URL → iframe」；产物下载同理。绝不为了"能预览/能下载"
   给接口开匿名口子。

6. **产物缺失时优雅回退**。
   `resolveWebDist()` 用 `import.meta.url` 定位（与 cwd 无关，可被 `BM_WEB_DIST`
   覆盖）；`index.html` 不存在就回退轻量引导页（`apps/gateway/src/bootstrap.ts`），
   给出 `npm run web:build` 的构建指引。`git clone && npm start` 依旧开箱可用。
   旧的内联 HTML 控制台（原 `console.ts` 与 `/console-legacy` 路由）已删除。

## 3. 缓存与部署

- `assets/index-<hash>.js` → `Cache-Control: public, max-age=31536000, immutable`
- `index.html` / `favicon.svg` 等 → `no-cache`（发版后用户必须拿到新壳）
- 路径穿越守卫：`resolve()` 之后必须仍在 root 之内，否则拒绝——这段代码在
  **鉴权之前**执行，属于安全边界，有专门用例把关（见下）。
- `/health` 返回 `web: { built, dist, builtAt }`：部署到一半只更新了后端、
  忘了构建前端时能一眼看出来。

## 4. 测试与验证

- `tests/web-console.test.ts`（5 例，全离线，用临时目录自造产物，不依赖真实构建）：
  路径穿越（越界目标**真实存在**，排除"文件不存在造成假通过"）、未就绪不放行、
  产物就绪时的入口/缓存头/免鉴权静态资源、产物缺失时的回退、目录定位与 `BM_WEB_DIST` 覆盖。
- 真机冒烟（人工执行，不进 CI——需要本机 Chrome）：
  `services/collector-core/.venv/bin/python` 里有 Playwright，`channel="chrome"` 免下载：
  四个页面真实渲染、任务详情六阶段/4 统计块/4 页签/41 条事件回放、
  权重≠1 时提交按钮禁用、浏览器 console 零 error。

## 5. 怎么扩展

- **加页面**：`src/pages/XxxPage.tsx` → `App.tsx` 加路由 → `AppShell.tsx` 的 `MENU` 加一项。
- **加接口**：`api/endpoints.ts` 加方法（路径只写这一处）→ 需要新类型时在
  `api/types.ts` 从契约包派生。
- **加状态/颜色**：改 `theme.ts` 的 `STATUS_*` / `DEGRADE_LABEL`，不要在页面里散落三元表达式。
- **后端加阶段**：只改 `packages/contracts`，前端看板/下拉自动跟上。

## 6. 已知限制

- `npm run web:build` 后网关**不会**自动感知：`static.ts` 在进程启动时解析一次目录，
  重新构建后需重启网关（或直接用 `web:dev` 开发态）。
- antd 全量引入使 vendor 包 ≈1.2MB（gzip 388KB）。内网控制台可接受；
  若要优化，走 `antd` 的按需 CSS-in-JS 已是默认，进一步需上 bundle 分析与
  `babel-plugin-import` 级别的裁剪。
- 知识库「文档列表」只列**通过入库通道**创建的文档；`scripts/seed.ts` 直接写的
  chunk 没有 doc 行，所以库况有块数而列表为空是正常现象。
