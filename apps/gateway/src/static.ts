/**
 * 前端构建产物托管（React + Ant Design 控制台）。
 *
 * 为什么由网关自己托管、而不是再起一个 nginx/静态服务器：
 *   这套系统承诺「私有化离线部署只有 brandsale 一个进程」。多一个进程就多一份
 *   端口、配置、健康检查与运维脚本。网关已经在对外的唯一端口上，托管几个静态文件
 *   是它顺手的事；同源还免掉了 CORS 与 token 跨域传递的一堆问题。
 *
 * 兼容策略：产物不存在时**不报错**，由调用方回退到轻量引导页
 *   （apps/gateway/src/bootstrap.ts）。这样 `git clone && npm start` 依然可用，
 *   不需要先跑一次前端构建才能看到界面（引导页会给出构建指引）。
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface StaticMount {
  /** 构建产物根目录（绝对路径） */
  root: string;
  /** index.html 是否存在。false 时调用方必须回退，不能直接 404 */
  ready: boolean;
}

/**
 * 解析产物目录。
 *
 * 用 `import.meta.url` 而不是 `process.cwd()`：网关可能被从任意工作目录启动
 * （`npm start`、`node dist/main.js`、systemd unit），只有模块自身的位置是稳定的。
 * `BM_WEB_DIST` 可覆盖，给"前端由 CDN 发布、网关只做回退"的部署留口子。
 */
export function resolveWebDist(): StaticMount {
  const override = process.env.BM_WEB_DIST?.trim();
  const root = override
    ? resolve(override)
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  return { root, ready: existsSync(resolve(root, "index.html")) };
}

/** 读取产物的构建时间（index.html 的 mtime），用于健康检查自证"跑的是哪一版" */
export function webDistBuiltAt(mount: StaticMount): string | null {
  if (!mount.ready) return null;
  try {
    return statSync(resolve(mount.root, "index.html")).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * 尝试把一个 GET 请求当作静态资源处理。
 *
 * @returns 已响应返回 true；未命中（调用方继续走后续逻辑）返回 false
 */
export function serveStatic(mount: StaticMount, pathname: string, res: ServerResponse): boolean {
  if (!mount.ready) return false;

  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!rel) return false;

  const target = resolve(mount.root, rel);

  // 防目录穿越：`/../../.env` 经过 resolve 之后必须仍在 root 之内。
  // 这条守卫不能省——网关对 `/` 的处理在鉴权之前，静态段一旦越界就是未授权文件读取。
  if (target !== mount.root && !target.startsWith(mount.root + sep)) return false;

  if (!existsSync(target) || !statSync(target).isFile()) return false;

  const ext = extname(target).toLowerCase();
  const size = statSync(target).size;
  // Vite 把打包产物放在 assets/ 下，文件名形如 index-DklxeQxw.js（内容哈希）。
  // 这类文件可以长缓存；dist 根目录下的东西（index.html、public/ 拷贝过来的
  // favicon 等）**不带哈希**，一旦长缓存就会出现"发版了但用户还在用旧壳"。
  const hashed = rel.startsWith("assets/") && /-[0-9a-zA-Z_]{8,}\.[a-z0-9]+$/i.test(rel);

  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": String(size),
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(target).pipe(res);
  return true;
}
