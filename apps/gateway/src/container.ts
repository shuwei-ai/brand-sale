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
import { KnowledgeService, PricingStore, createParser, buildReportSummary, renderSummaryText, SUMMARY_SOURCE_ID, type DocumentParser } from "@brandsale/knowledge";
import { createRegistry as createDataSourceRegistry } from "@brandsale/datasource";
import { AgentPack } from "@brandsale/agent-pack";
import { RenderService } from "@brandsale/render";
import { EventBus, Orchestrator } from "@brandsale/orchestrator";
import { DreamAuthClient } from "./dreamauth.ts";

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
  /** DreamAuth 扫码登录客户端（第三方托管开放平台） */
  dreamAuth: DreamAuthClient;
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
  const pricing = new PricingStore(db, { allowDemo: config.allowDemoData });
  const datasources = createDataSourceRegistry(db, config);
  const render = new RenderService(config);
  const dreamAuth = new DreamAuthClient(config.dreamAuth);
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

  /* 启动提示：向量索引配置自相矛盾时提前说清，别等检索时静默降级。
   * Milvus 里存的必须是模型向量；没有嵌入服务就没有"语义"，配了也只是白跑。 */
  if (config.retrieval.vectorDriver === "milvus" && !config.retrieval.embedUrl) {
    warnings.push(
      "BM_VECTOR_DRIVER=milvus 但 BM_EMBED_URL 为空：外部向量索引不会启用（语义通道退回本地哈希向量）。Milvus 必须配合嵌入服务使用，先 `npm run embedding:up` 并配置 BM_EMBED_URL。",
    );
  }
  if (!config.retrieval.embedUrl) {
    warnings.push(
      "未配置 BM_EMBED_URL：检索的语义通道仍使用 256 维字符哈希占位实现（本质是词袋，不是语义向量）。要启用真语义检索，起嵌入服务后设置 BM_EMBED_URL，并 `npm run embedding:backfill` 补算存量向量。",
    );
  }

  /* 云端嵌入端点的两个高频错配，启动时就说清楚，别等检索静默降级：
   *   ① 远端地址没配 Key → 每次嵌入 401，语义通道全灭而 BM25 照常，看起来"检索正常"；
   *   ② 换了模型没改维度 → 首次嵌入就抛维度不匹配（bge-m3 是 1024，不是 768）。 */
  if (config.retrieval.embedUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(config.retrieval.embedUrl)) {
    if (!config.retrieval.embedApiKey) {
      warnings.push(
        `BM_EMBED_URL 指向远端（${config.retrieval.embedUrl}）但未配置 BM_EMBED_API_KEY：该端点大概率返回 401，语义通道会全部降级为关键词检索。`,
      );
    }
  }
  if (/bge-m3/i.test(config.retrieval.embedModel) && config.retrieval.embedDim !== 1024) {
    warnings.push(
      `BM_EMBED_MODEL=${config.retrieval.embedModel} 的原生维度是 1024，但 BM_EMBED_DIM=${config.retrieval.embedDim}：首次嵌入会抛维度不匹配。改完还需 npm run embedding:backfill -- --force 与 npm run vector:rebuild -- --reset。`,
    );
  }

  const bus = new EventBus(repos);
  const orchestrator = new Orchestrator({
    config,
    repos,
    agentPack,
    render,
    bus,
    /**
     * 报告产出后把「机械抽取的摘要」回灌 KB-2（P1）。
     *
     * 为什么放在装配层：orchestrator 不允许依赖 knowledge（依赖矩阵），
     * 而这件事需要同时用到两者——回灌要写知识库，时机由编排层给。
     *
     * 为什么用**机械抽取**而不是让模型总结：摘要会被后续任务当既往资料检索到。
     * 一旦它是模型生成的，就形成「模型产物→存库→被当事实引用→再生成模型产物」的回环，
     * 报告里每个数字仍"挂着引用"，但引用指向的是另一个模型的猜测（集成方案 §5.1）。
     *
     * 幂等：title 与 publishedAt 都由 jobId / job.createdAt 决定 → 同一任务的
     * rerun 覆盖同一份文档，而不是在库里堆出多份几乎相同的摘要。
     */
    onReportReady: async ({ job, dsl, ctx }) => {
      if (!config.knowledge.summaryIngest) return;
      const summary = buildReportSummary(dsl, job);
      await knowledge.ingestGeneratedDocument(
        {
          title: `报告摘要 ${job.jobId}`,
          collection: "KB-2",
          sourceId: SUMMARY_SOURCE_ID,
          mime: "text/markdown",
          content: renderSummaryText(summary),
          publishedAt: job.createdAt,
          sampleSize: summary.keyNumbers.length,
          meta: {
            jobId: job.jobId,
            // derived=true：下游算"多源交叉一致度"时必须把它排除（否则自证自话）
            derived: true,
            kind: SUMMARY_SOURCE_ID,
            reportTitle: summary.title,
            sections: summary.sections.length,
            keyNumbers: summary.keyNumbers.length,
          },
        },
        { tenantId: ctx.tenantId, jobId: job.jobId, traceId: ctx.traceId },
      );
    },
  });

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
    dreamAuth,
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
