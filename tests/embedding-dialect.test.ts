/**
 * 嵌入端点的「方言」契约（本地内核 vs 云端 OpenAI 兼容 API）
 *
 * 运行：npm test —— 全部打本地 HTTP 桩，不访问任何真实外部服务。
 *
 * 为什么这些用例必须存在：
 *   换嵌入模型最容易出的不是"报错"，而是**静默降级**——
 *     · 云端端点不认 `input_type` / `dimensions`，旧实现无条件发这两个字段，
 *       实测 SiliconFlow 直接返回 HTTP 400（code 20015），语义通道整条失效，
 *       而检索会安静地退回 BM25，看起来"一切正常"；
 *     · 云端没有 `GET /health`，旧探活打过去 404 → 被当成"嵌入服务不可用"；
 *     · 换了模型不改 BM_EMBED_DIM（bge-m3 是 1024），首次嵌入就抛维度不匹配，
 *       但错误信息如果不点明"去改哪个变量"，运维会去查网络而不是查配置。
 *   这三条都不会自己喊出来，所以每条都要有断言把住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { HttpEmbeddingProvider, resolveEmbedDialect } from "@brandsale/knowledge";

interface Captured {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** 起一个只做两件事的桩：记录请求、按 dim 回固定维度的向量。 */
function startStub(dim: number): Promise<{ url: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      captured.push({ path: req.url ?? "", method: req.method ?? "", headers: req.headers, body });

      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          data: inputs.map((_: unknown, i: number) => ({ embedding: Array.from({ length: dim }, (_, k) => (k === i ? 1 : 0)), index: i })),
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1/embeddings`,
        captured,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("auto 方言：有 Key 判为 openai，无 Key 判为本地内核", () => {
  assert.equal(resolveEmbedDialect("auto", "sk-xxx"), "openai");
  assert.equal(resolveEmbedDialect("auto", ""), "embeddinggemma");
  // 显式值优先于推断：本地起一个要鉴权的反代时也说得通
  assert.equal(resolveEmbedDialect("embeddinggemma", "sk-xxx"), "embeddinggemma");
  assert.equal(resolveEmbedDialect("openai", ""), "openai");
});

test("openai 方言：带 Bearer，且**不发** input_type / dimensions", async () => {
  const stub = await startStub(1024);
  try {
    const p = new HttpEmbeddingProvider({ url: stub.url, model: "BAAI/bge-m3", dim: 1024, apiKey: "sk-test" });
    const vecs = await p.embed(["赫莲娜黑绷带"], { inputType: "query" });

    assert.equal(vecs.length, 1);
    assert.equal(vecs[0]!.length, 1024);

    const req = stub.captured[0]!;
    assert.equal(req.headers.authorization, "Bearer sk-test");
    assert.equal(req.body.model, "BAAI/bge-m3");
    // 这两条是本次适配的核心：SiliconFlow 对它们直接 400
    assert.equal("input_type" in req.body, false);
    assert.equal("dimensions" in req.body, false);
  } finally {
    await stub.close();
  }
});

test("embeddinggemma 方言：不发 Authorization，但必须带 input_type 与 dimensions", async () => {
  const stub = await startStub(768);
  try {
    const p = new HttpEmbeddingProvider({ url: stub.url, model: "embeddinggemma-2", dim: 768 });
    await p.embed(["文档正文"], { inputType: "document" });

    const req = stub.captured[0]!;
    assert.equal(req.headers.authorization, undefined);
    // task 前缀靠它注入：漏了不会报错，只会静默掉精度
    assert.equal(req.body.input_type, "document");
    assert.equal(req.body.dimensions, 768);
  } finally {
    await stub.close();
  }
});

test("openai 方言的探活走真实嵌入请求（云端没有 /health）", async () => {
  const stub = await startStub(1024);
  try {
    const p = new HttpEmbeddingProvider({ url: stub.url, model: "BAAI/bge-m3", dim: 1024, apiKey: "sk-test" });
    assert.equal(await p.health(), true);
    // 打到的是 /v1/embeddings，而不是 /health
    assert.equal(stub.captured.every((c) => c.path === "/v1/embeddings"), true);
  } finally {
    await stub.close();
  }
});

test("维度不符时错误信息要点名 BM_EMBED_DIM 与重建动作", async () => {
  const stub = await startStub(768); // 端点实际给 768
  try {
    const p = new HttpEmbeddingProvider({ url: stub.url, model: "BAAI/bge-m3", dim: 1024, apiKey: "sk-test" });
    await assert.rejects(
      () => p.embed(["任意文本"]),
      (e: Error) => {
        assert.match(e.message, /维度不匹配/);
        assert.match(e.message, /BM_EMBED_DIM/);
        assert.match(e.message, /vector:rebuild/);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("401 时错误信息点明是 Key 问题，而不是笼统的 HTTP 错误", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "invalid api key" }));
  });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}/v1/embeddings`);
    });
  });

  try {
    const p = new HttpEmbeddingProvider({ url, model: "BAAI/bge-m3", dim: 1024, apiKey: "bad" });
    await assert.rejects(
      () => p.embed(["x"]),
      (e: Error) => {
        assert.match(e.message, /401/);
        assert.match(e.message, /API Key/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
