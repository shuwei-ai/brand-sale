/**
 * 来源登记不变量 + 入库来源守卫（WP-D2 / WP-A）。
 *
 * 这个文件要解决的是同一类问题的两端：
 *
 * **登记端**（assertSourceRegistration）：防止把来源"洗白"。
 *   台账里的 `authMethod` / `contractRef` 字段的语义是**授权凭据**。
 *   给一个公开爬取类来源填上 `contractRef`，它就从一个"未授权采集"变成了
 *   台账上看起来"已签合同"的源，报告里也就能标成甲方授权实测——
 *   而实际上不存在任何合同。这与项目早期删掉 5 个合成适配器是同一类错误
 *   （那次是假数据装真数据，这次是未授权装已授权）。
 *   所以这里把规则写死：**L3 禁止填 contractRef**，L1/L2 必须填齐三件套。
 *
 * **入库端**（createIngestSourceGuard）：防止把来路不明的数据写进知识库。
 *   入库是"入站写"，不走数据出站的闸门，但来源合法性必须**同等严格**：
 *   否则「甲方把来路不明的数据丢进 KB → 报告引用它 → 来源声明标成 L3 已核验」
 *   就成了一条新的合规漏洞，而且比出站漏洞更隐蔽（数据已经躺在库里了）。
 */

import { AppError, type IngestSourceGuard, type SourceRegistration } from "@brandsale/contracts";
import type { Repositories } from "@brandsale/storage";

/**
 * 登记前的组合校验。不合法直接抛错，**不写入台账**。
 *
 * 分级规则：
 *   L1 客户授权平台数据、L2 历史执行与私域知识
 *     → 必须有 authMethod（授权凭据形式）+ contractRef（授权条款出处）+ legalApproved
 *   L3 公开数据（联网检索、公开网页采集）
 *     → **禁止填 contractRef**（公开数据没有合同，填了就是伪造成授权实测）
 *   L4 采购数据
 *     → **不在本函数约束**。它的门是访问期的双开关（config.tiers.L4 + legalApproved），
 *       那比一个字符串字段强得多。刻意允许"先登记、合同后补、使用前必须补齐"——
 *       这是既有设计（E2E-10 就依赖它），本函数不去动它。
 */
export function assertSourceRegistration(src: SourceRegistration): void {
  const id = src.sourceId;

  if (src.tier === "L3") {
    if (src.contractRef) {
      throw new AppError({
        code: "E-GOV-005",
        message: `L3 来源 ${id} 不允许填写 contractRef`,
        userMessage:
          `公开数据来源「${id}」不能填写合同编号：L3 是公开采集/公开检索数据，不存在授权合同。` +
          `填了会让报告把它当作"甲方授权实测数据"引用。如果确实已与平台签约，请把分级改为 L1。`,
        details: { sourceId: id, tier: src.tier, contractRef: src.contractRef },
      });
    }
    return;
  }

  if (src.tier === "L1" || src.tier === "L2") {
    const missing: string[] = [];
    if (!src.authMethod) missing.push("authMethod");
    if (!src.contractRef) missing.push("contractRef");
    if (!src.legalApproved) missing.push("legalApproved");
    if (missing.length) {
      throw new AppError({
        code: "E-GOV-005",
        message: `${src.tier} 来源 ${id} 缺少必填项：${missing.join(", ")}`,
        userMessage:
          `${src.tier} 是客户授权数据，必须同时提供授权形式与合同出处并取得法务批准。` +
          `缺少：${missing.join("、")}。`,
        details: { sourceId: id, tier: src.tier, missing },
      });
    }
    return;
  }
}

/**
 * 入库来源守卫。
 *
 * 校验三件事，任意一项不通过都**拒绝写入**（不是写入后标记）：
 *   1. 来源已在台账登记
 *   2. L4 来源法务已批准（双开关之一，另一个是 config.tiers.L4，由闸门判）
 *   3. 该租户对该来源有**生效中**的授权
 *
 * 为什么"公开数据也要授权"：闸门的 authz 检查对**所有分级**一视同仁
 * （见 gate.ts case "authz"），联网检索（L3）同样需要 grantAuthz 才能用。
 * 入库如果比出站松，就会出现"能写进去但读不出来"或反之的错位。
 * 严格对齐闸门是这里唯一正确的取值。
 *
 * 复用 `repos.sources` / `repos.authz` 而不是自己写 SQL：授权是否"生效中"
 * 的语义（含有效期与撤销）已经在 AuthzRepo.active() 里实现过一次，
 * 再写一遍就是第二份真相。
 */
export function createIngestSourceGuard(repos: Repositories): IngestSourceGuard {
  return (tenantId, sourceId) => {
    const src = repos.sources.get(tenantId, sourceId);
    if (!src) {
      return { ok: false, reason: `来源 ${sourceId} 未在来源台账登记` };
    }
    if (src.tier === "L4" && !src.legalApproved) {
      return { ok: false, reason: `L4 来源 ${sourceId} 未获法务批准（双重开关未同时满足）` };
    }
    const az = repos.authz.active(tenantId, sourceId);
    if (!az) {
      const any = repos.authz.list(tenantId).find((a) => a.sourceId === sourceId);
      if (any && any.status === "active" && new Date(any.validTo) < new Date()) {
        return { ok: false, reason: `来源 ${sourceId} 的授权已于 ${any.validTo} 过期` };
      }
      if (any?.status === "revoked") {
        return { ok: false, reason: `来源 ${sourceId} 的授权已被撤销` };
      }
      return { ok: false, reason: `来源 ${sourceId} 没有生效中的授权` };
    }
    return { ok: true, tier: src.tier, sourceType: src.sourceType, sourceName: src.name };
  };
}
