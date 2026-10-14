/**
 * 前端未构建时的引导页（替代已删除的零构建旧控制台）。
 *
 * 设计约束：
 *   - 零依赖、零外部资源（离线私有化环境不能引用任何 CDN）；
 *   - 只做一件事：告诉用户界面在哪里、怎么把前端构建出来；
 *   - 不做任何 API 调用 —— 它出现在"前端没构建"的场景里，
 *     此时连静态资源都拿不到，再交互也是死胡同。
 *
 * `git clone && npm start` 依然开箱可用：看到的不再是旧界面，
 * 而是一条明确的构建指引。
 */

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>brandsale · 前端未构建</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f5f6f8; color: #1f2329; padding: 24px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #141414; color: rgba(255,255,255,.88); }
    code, .hint { background: #1f1f1f; }
  }
  .card {
    max-width: 560px; width: 100%;
    background: #fff; border: 1px solid #e5e6eb; border-radius: 12px;
    padding: 40px 44px; box-shadow: 0 6px 24px rgba(0,0,0,.06);
  }
  @media (prefers-color-scheme: dark) {
    .card { background: #1f1f1f; border-color: #303030; box-shadow: none; }
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 12px; }
  p { font-size: 14px; line-height: 1.8; color: #4e5969; }
  @media (prefers-color-scheme: dark) { p { color: rgba(255,255,255,.65); } }
  code {
    display: block; margin: 20px 0 4px; padding: 12px 16px;
    background: #f2f3f5; border-radius: 8px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 13px; color: #d63384; white-space: pre; overflow-x: auto;
  }
  @media (prefers-color-scheme: dark) { code { color: #ff85c0; } }
  .hint { margin-top: 24px; padding: 10px 14px; border-radius: 8px; background: #f2f3f5; font-size: 12.5px; }
</style>
</head>
<body>
  <main class="card">
    <h1>前端控制台尚未构建</h1>
    <p>React 控制台的构建产物（<code style="display:inline;padding:2px 6px;margin:0">apps/web/dist</code>）不存在，
       所以网关没有界面可以托管。在项目根目录执行一次：</p>
    <code>npm install &amp;&amp; npm run web:build &amp;&amp; npm start</code>
    <p>然后刷新本页面即可进入控制台。</p>
    <div class="hint">
      开发态热更可用 <strong>npm run web:dev</strong>（Vite 5173，接口代理到网关）；
      部署产物位置可用环境变量 <strong>BM_WEB_DIST</strong> 覆盖；
      当前前端构建状态也可以随时从 <strong>GET /health</strong> 的 <strong>web.built</strong> 字段确认。
    </div>
  </main>
</body>
</html>`;

export function bootstrapHtml(): string {
  return PAGE;
}
