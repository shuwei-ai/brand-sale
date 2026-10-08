/**
 * 存储 CLI：迁移 / 状态查询
 *   tsx packages/storage/src/cli.ts migrate
 *   tsx packages/storage/src/cli.ts status
 */

import { loadConfig } from "@brandsale/config";
import { migrate, openDb } from "./db.ts";

const cmd = process.argv[2] ?? "migrate";
const config = loadConfig();
const db = openDb(config.storage.sqlitePath);

try {
  switch (cmd) {
    case "migrate": {
      const { applied, skipped } = migrate(db);
      console.log(`[storage] 已应用迁移: [${applied.join(", ")}]，跳过: [${skipped.join(", ")}]`);
      console.log(`[storage] 数据库: ${config.storage.sqlitePath}`);
      break;
    }
    case "status": {
      const tables = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      console.log(`[storage] ${config.storage.sqlitePath}`);
      for (const t of tables) {
        const c = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM "${t.name}"`);
        console.log(`  - ${t.name.padEnd(20)} ${c?.c ?? 0}`);
      }
      break;
    }
    default:
      console.error(`未知命令: ${cmd}（可用：migrate | status）`);
      process.exitCode = 1;
  }
} finally {
  db.close();
}
