/**
 * Pi 循环「工具调用风暴」闸门的确定性测试。
 *
 * 背景（真机日志）：双十一自测那次，intel 阶段同一个 `platform_digest` 被连续调用
 * **131 次**，每次都被 maxCallsPerJob 拒绝、每次都记一条 rate_limited 降级。
 * 整个阶段的预算被这些必然失败的往返烧光：Pi 循环只吐出一句半截话，
 * 结构化解析失败；轮到直连兜底时预算已耗尽，又被打成 E-AGENT-002 ——
 * 报告整体降级成模板合成（用户看到的就是"数据采到了，报告里却还是占位"）。
 *
 * 闸门的判据是计数器，不依赖 Agent 循环本身，所以这里直接测规则。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createToolCallGuard } from "@brandsale/agent-pack";

test("闸门：同一工具 + 相同参数重复到第 4 次起被拒（前 3 次放行）", () => {
  const guard = createToolCallGuard(["platform_digest"]);
  const args = { op: "search", keyword: "精华" };

  for (let i = 0; i < 3; i += 1) {
    assert.equal(guard.attempt("platform_digest", args), undefined, `第 ${i + 1} 次应放行`);
  }
  const fourth = guard.attempt("platform_digest", args);
  assert.equal(fourth?.block, true, "第 4 次应被拦下");
  assert.match(fourth?.reason ?? "", /相同参数/);
  assert.notEqual(fourth?.terminate, true, "偶尔一次拒绝还不该终止整个循环");
});

test("闸门：参数不同就不算重复（换关键词仍然放行）", () => {
  const guard = createToolCallGuard(["platform_digest"]);
  for (const kw of ["精华", "施华蔻", "赫莲娜", "双十一 精华"]) {
    assert.equal(guard.attempt("platform_digest", { op: "search", keyword: kw }), undefined, `${kw} 应放行`);
  }
  assert.equal(guard.stats().toolCalls, 4);
});

test("闸门：连续被拒到阈值 → terminate（把预算留给直连兜底，而不是死循环）", () => {
  const guard = createToolCallGuard(["platform_digest"]);
  const args = { op: "search", keyword: "精华" };
  let terminated = false;
  // 前 3 次放行；之后一直重复调用同一个参数
  for (let i = 0; i < 40 && !terminated; i += 1) {
    const d = guard.attempt("platform_digest", args);
    if (d?.terminate) terminated = true;
  }
  assert.equal(terminated, true, "重复调用风暴必须能触发 terminate");
  assert.ok(guard.stats().toolCalls <= 30 + 6, "终止前不应无限跑下去");
});

test("闸门：单阶段工具调用总量有硬上限", () => {
  const guard = createToolCallGuard(["platform_digest"]);
  let hit = false;
  for (let i = 0; i < 60 && !hit; i += 1) {
    // 每次换参数，绕开"同一调用"那条规则，专门压总量上限
    const d = guard.attempt("platform_digest", { op: "search", keyword: `kw-${i}` });
    if (d?.terminate) hit = true;
  }
  assert.equal(hit, true, "总量上限必须能触发 terminate");
});

test("闸门：白名单外的工具被拒，并列出可用工具", () => {
  const guard = createToolCallGuard(["platform_digest", "web_search"]);
  const d = guard.attempt("drop_database", {});
  assert.equal(d?.block, true);
  assert.match(d?.reason ?? "", /platform_digest/);
  assert.match(d?.reason ?? "", /web_search/);
});
