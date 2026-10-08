/**
 * M5 LineageLedger（对应 LLD §2.6）
 *
 * 职责：记录「每一条数据从哪来、谁授权、流向哪个知识库」。
 * Phase 1 落地为本地表 + 可导出的 OpenLineage RunEvent JSON；
 * BM_MARQUEZ_URL 非空时可由 sidecar 消费这些事件。
 */

import type { DataTier, LedgerEntry, TenantContext } from "@brandsale/contracts";
import type { Repositories } from "@brandsale/storage";

export interface LedgerInput {
  sourceId: string;
  tier: DataTier;
  query: string;
  rowCount: number;
  cached: boolean;
}

export interface LedgerOutput {
  artifactKind: string;
  ref: string;
  kbCollection?: string;
}

export interface LedgerRun {
  addInput(i: LedgerInput): void;
  addOutput(o: LedgerOutput): void;
  finish(): LedgerEntry;
}

export class LineageLedger {
  constructor(private repos: Repositories) {}

  begin(input: { ctx: TenantContext; jobId: string; phase: LedgerEntry["phase"]; agent: string | null; runId: string }): LedgerRun {
    const startedAt = new Date().toISOString();
    const inputs: LedgerInput[] = [];
    const outputs: LedgerOutput[] = [];

    return {
      addInput: (i) => void inputs.push(i),
      addOutput: (o) => void outputs.push(o),
      finish: () => {
        const entry: Omit<LedgerEntry, "ledgerId"> = {
          tenantId: input.ctx.tenantId,
          jobId: input.jobId,
          phase: input.phase,
          agent: input.agent,
          inputs,
          outputs,
          runId: input.runId,
          startedAt,
          endedAt: new Date().toISOString(),
        };
        return this.repos.ledger.add(entry);
      },
    };
  }

  byJob(jobId: string): LedgerEntry[] {
    return this.repos.ledger.byJob(jobId);
  }
}

/**
 * 生成 OpenLineage 风格的 RunEvent，供 Marquez / 数据目录消费。
 * 字段命名遵循 OpenLineage 1.x 的 RunEvent 结构子集。
 */
export function toOpenLineageRunEvent(entry: LedgerEntry): Record<string, unknown> {
  return {
    eventType: "COMPLETE",
    eventTime: entry.endedAt,
    run: { runId: entry.runId, facets: { jobId: { jobId: entry.jobId }, phase: { phase: entry.phase } } },
    job: { namespace: "brandsale", name: `${entry.phase}.${entry.agent ?? "system"}` },
    inputs: entry.inputs.map((i) => ({
      namespace: "brandsale.datasource",
      name: i.sourceId,
      facets: {
        dataQualityMetrics: { rowCount: i.rowCount },
        tier: { tier: i.tier },
        cached: { cached: i.cached },
      },
    })),
    outputs: entry.outputs.map((o) => ({
      namespace: "brandsale.artifact",
      name: o.ref,
      facets: { kind: { kind: o.artifactKind }, kb: { collection: o.kbCollection ?? null } },
    })),
    producer: "brandsale/ledger/0.1.0",
  };
}
