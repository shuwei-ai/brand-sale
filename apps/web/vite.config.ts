import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/**
 * 前端构建配置。
 *
 * 两个刻意的选择：
 *  ① `@brandsale/contracts` 别名指向**契约包源码**而不是打包产物。
 *     契约包是纯类型 + 纯常量（零 node 依赖，见 packages/contracts），
 *     让前端直接用同一份 API_PREFIX / PHASE_LABEL / KB_COLLECTIONS，
 *     就不会出现"后端加了阶段、前端漏渲染"这类漂移。
 *  ② 开发态把 /api 与 /health 代理到本地网关。
 *     生产构建由网关自己托管 dist（见 apps/gateway/src/static.ts），
 *     同源部署，因此前端代码里不需要任何跨域或 baseURL 配置。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@brandsale/contracts": resolve(repoRoot, "packages/contracts/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787" },
      "/health": { target: "http://127.0.0.1:8787" },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor_react: ["react", "react-dom", "react-router-dom"],
          vendor_antd: ["antd", "@ant-design/icons"],
        },
      },
    },
  },
});
