import { loadConfig } from "@brandsale/config";
import { createContainer } from "./container.ts";
import { createGateway } from "./server.ts";
import { resolveWebDist } from "./static.ts";
import { seedIfEmpty, ensureBuiltinSources } from "../../../scripts/seed.ts";

const config = loadConfig();

// 开发态自举：空库自动灌种子（生产环境不做任何隐式写库）
if (config.env === "dev" && process.env.BM_AUTO_SEED !== "0") {
  const s = await seedIfEmpty();
  if (s.seeded) console.log(`[seed] 空库自举完成：知识库 ${s.chunks} 条、达人 ${s.talents} 位`);
  // 空库自举只在空库生效，老库要靠这一步补齐后加的数据源（如联网检索），
  // 否则工具会在闸门的 source 检查上一直降级，而代码看不出任何问题
  const added = await ensureBuiltinSources(config);
  if (added.length) console.log(`[seed] 补齐内置数据源：${added.join("、")}`);
}

const container = createContainer(config);
const web = resolveWebDist();

for (const w of container.warnings) console.warn(`[config] ⚠️  ${w}`);

const server = createGateway(container, web);
server.listen(config.httpPort, () => {
  const health = container.gateway.mocked ? "mock（离线桩）" : `${config.llm.baseUrl} · ${config.llm.models.medium}`;
  console.log(`[gateway] 监听 http://127.0.0.1:${config.httpPort}  env=${config.env}`);
  console.log(`[gateway] 模型：${health}`);
  console.log(`[gateway] 数据库：${config.storage.sqlitePath}`);
  console.log(`[gateway] 鉴权：Authorization: Bearer t.<tenantId>.<userId>`);
  console.log(
    web.ready
      ? `[gateway] 控制台：React 构建产物 ${web.root}`
      : `[gateway] 控制台：未找到前端构建产物（${web.root}），已回退内置零构建控制台。构建：npm run web:build`,
  );
});

const shutdown = (): void => {
  console.log("\n[gateway] 正在关闭…");
  server.close(() => {
    container.close();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
