/**
 * 装配根（Composition Root）
 *
 * 全系统**唯一**把各模块拼起来的地方。依赖方向严格单向：
 *   apps → orchestrator → agent-pack → {governance, knowledge, datasource, model-gateway} → storage → contracts
 *
 * M4（datasource）只在这里被注入到 M10 的工具层，**没有任何模块可以直接拿到它**，
 * 从而在代码层面保证「没有模块可以绕过闸门访问数据源」（LLD §2.1 的设计约束）。
 */

import { loadConfig, assertConfigInvariants, type Config } from "@brandsale/config";
import { migrate, openDb, Repositories } from "@brandsale/storage";
import { GovernanceGate, LineageLedger, createIngestSourceGuard, externalCatalogKeys } from "@brandsale/governance";
import { ModelGateway } from "@brandsale/model-gateway";
import { KnowledgeService, PricingStore, createParser, type DocumentParser } from "@brandsale/knowledge";
import { createRegistry as createDataSourceRegistry } from "@brandsale/datasource";
import { AgentPack } from "@brandsale/agent-pack";
import { RenderService } from "@brandsale/render";
import { EventBus, Orchestrator } from "@brandsale/orchestrator";

export interface Container {
  config: Config;
  repos: Repositories;
  gate: GovernanceGate;
  ledger: LineageLedger;
  gateway: ModelGateway;
  knowledge: KnowledgeService;
  pricing: PricingStore;
  agentPack: AgentPack;
  render: RenderService;
  /** 文档解析器：KB 入库通道用它把 pdf/docx 转成文本 */
  parser: DocumentParser;
  bus: EventBus;
  orchestrator: Orchestrator;
  warnings: string[];
  close(): void;
}

export function createContainer(config: Config = loadConfig()): Container {
  const warnings = assertConfigInvariants(config);
  const db = openDb(config.storage.sqlitePath);
  migrate(db);
  const repos = new Repositories(db);

  const gate = new GovernanceGate({
    repos,
    config,
    semanticPolicy: {
      // 语义层红线：单次任务预算上限、显式拒绝的源
      maxBudgetAmount: 50_000_000,
      deniedSources: [],
    },
  });
  const ledger = new LineageLedger(repos);
  const gateway = new ModelGateway(config, repos);
  // 入库来源守卫由这里注入：knowledge 不能依赖 governance（会让依赖矩阵多一条边），
  // 而"授权是否生效中"的语义只该有一份实现（AuthzRepo.active）。
  const knowledge = new KnowledgeService(db, config, createIngestSourceGuard(repos));
  const pricing = new PricingStore(db);
  const datasources = createDataSourceRegistry(db, config);
  const render = new RenderService(config);
  // 文档解析器（P1-5）：BM_PARSER_URL 非空即启用 MinerU，否则仅支持纯文本。
  // 未配置时 pdf/docx 上传会明确报 415，而不是被当成文本塞进库。
  const parser = createParser(config);

  const agentPack = new AgentPack({
    config,
    repos,
    gate,
    knowledge,
    pricing,
    datasources,
    gateway,
    ledger,
  });

  /* 启动不变量（P0-2）：来源目录里必须至少有一个**已授权的台账数据源**。
   * 目录为空 → 渲染期的来源合法性校验（R1）会把每一条来源声明都判成「不存在」，
   * 报告必被拒渲染。与其等任务跑完 60 秒再失败，不如在装配时就暴露配置问题。
   * 注意：本地 KB 语料源不在 sources 台账内，这里只校验台账源（靠 seed 播种）。 */
  const bootCatalog = agentPack.sourceCatalog({ tenantId: "tenant_demo", userId: "u_boot", traceId: "boot", locale: "zh-CN" });
  if (externalCatalogKeys(bootCatalog).length === 0) {
    warnings.push(
      "来源目录中没有任何已授权的台账数据源：请先执行 `npm run seed` 播种 sources/authz，否则报告的来源声明校验会失败、渲染被拒",
    );
  }

  /* 启动提示：未配置解析器时 KB 入库只接受纯文本。
   * 这不是错误——纯文本入库本身就是完整可用的通道（运营把公开情报贴进来即可）；
   * 但 pdf/docx 上传会被明确拒绝，所以提前告知，避免使用时才发现。 */
  if (!config.parser.url) {
    warnings.push(
      "未配置 BM_PARSER_URL：KB 入库通道目前只接受纯文本（text/plain、text/markdown）。上传 pdf/docx 会返回 415 E-INGEST-002。",
    );
  }

  const bus = new EventBus(repos);
  const orchestrator = new Orchestrator({ config, repos, agentPack, render, bus });

  return {
    config,
    repos,
    gate,
    ledger,
    gateway,
    knowledge,
    pricing,
    agentPack,
    render,
    parser,
    bus,
    orchestrator,
    warnings,
    close: () => {
      // 顺序很重要：先中断在跑的任务，再关连接，
      // 否则在途任务会在 db 关闭后继续写库 → "database is not open"
      orchestrator.shutdown();
      db.close();
    },
  };
}
