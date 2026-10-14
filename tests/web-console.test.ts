/**
 * 前端工程化（React + Ant Design）的托管契约自检。
 *
 * 为什么这个改动必须有用例：
 *   静态托管被插在**鉴权之前**（页面本身不含业务数据，不需要登录就能打开），
 *   于是"路径穿越防护"从"最好有"变成了"必须有"——一旦 `resolve()` 之后不校验
 *   是否仍在 root 之内，`/../../.env` 就是一次未授权的文件读取，
 *   而这类漏洞不会让任何测试变红，只会静静躺在那里。
 *
 * 第二个不变量是**回退**：产物不存在时 `/` 必须仍然可用（吐引导页告知构建方式），
 *   否则"clone 完直接 npm start"就是一屏裸 404——这是老用户在升级时最先撞到的事。
 *
 * 运行：npm test（不依赖真实前端构建，临时目录里造一套最小产物）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerResponse } from "node:http";
import { loadConfig } from "@brandsale/config";
import { createContainer, type Container } from "../apps/gateway/src/container.ts";
import { createGateway } from "../apps/gateway/src/server.ts";
import { resolveWebDist, serveStatic, type StaticMount } from "../apps/gateway/src/static.ts";

const SPA_MARK = "<title>SPA-MARKER-8f3a</title>";

/** 造一套最小构建产物：入口 html + 一个带内容哈希的资源 */
function makeDist(): { root: string; secret: string; dispose: () => void } {
  // 产物目录刻意嵌在一个临时父目录里，并在**父目录**放一个"机密文件"：
  // 只有这样 `/../secret.txt` 才会指向一个真实存在的越界文件，
  // 否则它会因为"文件不存在"而返回 false —— 用例就成了永远通过的摆设。
  const parent = mkdtempSync(join(tmpdir(), "brandsale-web-parent-"));
  const root = join(parent, "dist");
  const secret = join(parent, "secret.txt");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(secret, "SECRET-OUTSIDE-DIST");
  writeFileSync(join(root, "index.html"), `<!doctype html><html><head>${SPA_MARK}</head><body><div id="root"></div></body></html>`);
  writeFileSync(join(root, "assets", "index-DklxeQxw.js"), "console.log('spa')");
  writeFileSync(join(root, "favicon.svg"), "<svg/>");
  return { root, secret, dispose: () => rmSync(parent, { recursive: true, force: true }) };
}

const readyMount = (root: string): StaticMount => ({ root, ready: true });

async function bootServer(web: StaticMount, dataDir: string): Promise<{ server: Server; base: string; container: Container; dispose: () => Promise<void> }> {
  // 数据层用临时目录（各用例自己隔离），不走 seed —— 这个用例关心的是 HTTP
  // 静态托管与回退行为，不是业务数据
  const config = loadConfig(process.cwd(), { BM_DATA_DIR: dataDir, BM_LLM_MODE: "mock" });
  const container = createContainer(config);
  const server = createGateway(container, web);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    server,
    container,
    base: `http://127.0.0.1:${port}`,
    dispose: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      container.close();
    },
  };
}

/* ── ① 路径穿越防护：必须在写出任何字节之前就拒绝 ───────────── */

test("serveStatic 拒绝目录穿越，且不写出响应", () => {
  const dist = makeDist();
  const mount = readyMount(dist.root);
  const secret = dist.secret;
  try {
    // 一个"只要被写就炸"的响应桩：守卫若失效会立刻抛错，而不是静默返回 200
    const boom = {
      writeHead: () => {
        throw new Error("穿越请求不得写出响应");
      },
      on: () => {
        throw new Error("穿越请求不得开始推流");
      },
    } as unknown as ServerResponse;

    // 注意：HTTP 层 `new URL()` 会先把 `..` 归一化掉，所以这里的路径**直接**
    // 喂给 serveStatic —— 测的正是"归一化之后仍然越界"这最后一道守卫。
    for (const attack of [
      "/../secret.txt",
      "/../../secret.txt",
      "/assets/../../secret.txt",
      "/assets/../../../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
    ]) {
      assert.equal(serveStatic(mount, attack, boom), false, `应拒绝：${attack}`);
    }

    // 反向确认：越界目标**真实存在**，所以上面这些 false 只可能来自守卫本身，
    // 而不是"文件恰好不存在"造成的假通过
    assert.ok(existsSync(secret), "越界目标文件必须存在，否则这组用例是摆设");
  } finally {
    dist.dispose();
  }
});

test("serveStatic 在产物未就绪时一律不放行", () => {
  const dist = makeDist();
  try {
    const boom = {
      writeHead: () => {
        throw new Error("未就绪的挂载点不得写出响应");
      },
      on: () => {
        throw new Error("未就绪的挂载点不得开始推流");
      },
    } as unknown as ServerResponse;
    assert.equal(serveStatic({ root: dist.root, ready: false }, "/index.html", boom), false);
    assert.equal(serveStatic({ root: dist.root, ready: false }, "/assets/index-DklxeQxw.js", boom), false);
  } finally {
    dist.dispose();
  }
});

/* ── ② 产物就绪 → `/` 吐 SPA，缓存头正确，静态资源免鉴权 ────────── */

test("产物就绪时 `/`、`/console` 吐 SPA；哈希资源长缓存、入口 HTML 不缓存", async () => {
  const dist = makeDist();
  const dir = mkdtempSync(join(tmpdir(), "brandsale-web-data-"));
  const boot = await bootServer(readyMount(dist.root), dir);
  try {
    for (const path of ["/", "/console", "/console/", "/index.html"]) {
      const res = await fetch(boot.base + path);
      assert.equal(res.status, 200, `${path} 应 200`);
      const html = await res.text();
      assert.ok(html.includes(SPA_MARK), `${path} 应返回 SPA 入口`);
      // 入口 HTML 必须回源：否则前端发版后用户仍加载旧的资源引用
      assert.equal(res.headers.get("cache-control"), "no-cache", `${path} 不应被缓存`);
    }

    // 静态资源不带 Authorization 也必须拿得到，否则页面自身加载不出来
    const js = await fetch(`${boot.base}/assets/index-DklxeQxw.js`);
    assert.equal(js.status, 200);
    assert.match(String(js.headers.get("content-type")), /javascript/);
    assert.match(String(js.headers.get("cache-control")), /immutable/);
    assert.equal(await js.text(), "console.log('spa')");

    // 非 assets/ 下的静态文件（如 public/ 拷来的图标）不带哈希 → 不能长缓存
    const svg = await fetch(`${boot.base}/favicon.svg`);
    assert.equal(svg.status, 200);
    assert.match(String(svg.headers.get("content-type")), /image\/svg/);
    assert.equal(svg.headers.get("cache-control"), "no-cache");

    const health = (await (await fetch(`${boot.base}/health`)).json()) as {
      web: { built: boolean; dist: string; builtAt: string | null };
    };
    assert.equal(health.web.built, true, "健康检查应自证产物形态");
    assert.equal(health.web.dist, dist.root);
    assert.ok(health.web.builtAt);
  } finally {
    await boot.dispose();
    dist.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── ④ 产物缺失 → 回退引导页，而不是裸 404 ───────────────────── */

test("产物缺失时 `/` 回退构建引导页，旧控制台入口已移除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brandsale-web-data-"));
  const boot = await bootServer({ root: join(dir, "not-built"), ready: false }, dir);
  try {
    for (const path of ["/", "/console", "/index.html"]) {
      const res = await fetch(boot.base + path);
      assert.equal(res.status, 200, `${path} 应 200`);
      const html = await res.text();
      assert.ok(html.includes("npm run web:build"), `${path} 应给出构建指引`);
      assert.ok(!html.includes(SPA_MARK));
      assert.match(String(res.headers.get("cache-control")), /no-cache/);
    }

    // 旧零构建控制台已删除：/console-legacy 不再是特殊路径，
    // 落回既有语义 —— 无 token 时被鉴权拦截（401），而不是吐出一个旧界面
    const legacy = await fetch(`${boot.base}/console-legacy`);
    assert.equal(legacy.status, 401);

    const health = (await (await fetch(`${boot.base}/health`)).json()) as { web: { built: boolean } };
    assert.equal(health.web.built, false);

    // 未构建时 assets 不该被当成 SPA 入口吞掉，而是落到既有的 404/鉴权语义
    const missing = await fetch(`${boot.base}/assets/nope.js`);
    assert.notEqual(missing.status, 200);
  } finally {
    await boot.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── ⑤ 兜底：产物目录的定位必须与 cwd 无关 ──────────────────── */

test("resolveWebDist 默认指向 apps/web/dist，且可被 BM_WEB_DIST 覆盖", () => {
  // 只断言"定位到了哪里"，不断言"是否已构建"：`npm test` 承诺 clone 完就能跑，
  // 不该因为"还没执行前端构建"而变红。构建产物的存在性由 ③/④ 用临时目录自证。
  const base = resolveWebDist();
  assert.ok(base.root.endsWith(join("apps", "web", "dist")), `实际：${base.root}`);
  assert.equal(typeof base.ready, "boolean");

  const saved = process.env.BM_WEB_DIST;
  process.env.BM_WEB_DIST = join(tmpdir(), "custom-web-dist");
  try {
    assert.equal(resolveWebDist().root, join(tmpdir(), "custom-web-dist"));
  } finally {
    if (saved === undefined) delete process.env.BM_WEB_DIST;
    else process.env.BM_WEB_DIST = saved;
  }
});
