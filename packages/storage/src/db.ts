/**
 * M15 Storage 层：SQLite 实现（对应 LLD §4.2 DDL）
 *
 * 选 `node:sqlite` 而不是 better-sqlite3：Node 22 内置，无需原生编译，
 * 私有化交付时少一个构建变量。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Db {
  raw: DatabaseSync;
  exec(sql: string): void;
  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[];
  tx<T>(fn: () => T): T;
  close(): void;
}

export type SqlParam = null | number | string | bigint | Uint8Array;

export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "core",
    sql: `
    -- 任务
    CREATE TABLE IF NOT EXISTS jobs (
      job_id          TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      created_by      TEXT NOT NULL,
      status          TEXT NOT NULL,
      current_phase   TEXT,
      percent         REAL NOT NULL DEFAULT 0,
      spec_json       TEXT NOT NULL,
      degraded_json   TEXT NOT NULL DEFAULT '[]',
      idempotency_key TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      finished_at     TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(tenant_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    -- 阶段（checkpoint 的单位）
    CREATE TABLE IF NOT EXISTS job_phases (
      job_id       TEXT NOT NULL,
      phase        TEXT NOT NULL,
      status       TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      output_json  TEXT,
      error_code   TEXT,
      error_message TEXT,
      degraded_json TEXT,
      started_at   TEXT,
      ended_at     TEXT,
      cost_json    TEXT NOT NULL DEFAULT '{"currency":"CNY","amount":0}',
      PRIMARY KEY (job_id, phase)
    );

    -- 产物
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      job_id      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      inline_json TEXT,
      url         TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id, kind);

    -- 幂等登记：同 key 不同 body 指纹 → E-JOB-002
    CREATE TABLE IF NOT EXISTS idempotency (
      key         TEXT NOT NULL,
      tenant_id   TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      job_id      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );

    -- 事件环形缓冲（断线重连回放）
    CREATE TABLE IF NOT EXISTS job_events (
      job_id  TEXT NOT NULL,
      seq     INTEGER NOT NULL,
      type    TEXT NOT NULL,
      payload TEXT NOT NULL,
      at      TEXT NOT NULL,
      PRIMARY KEY (job_id, seq)
    );

    -- 用量：以 (job_id, phase, attempt, call_id) 唯一，重放不翻倍
    CREATE TABLE IF NOT EXISTS usage_records (
      record_id    TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL,
      phase        TEXT NOT NULL,
      attempt      INTEGER NOT NULL DEFAULT 0,
      call_id      TEXT NOT NULL,
      model        TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cost_amount  REAL NOT NULL DEFAULT 0,
      at           TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedupe
      ON usage_records(job_id, phase, attempt, call_id);

    -- 审计（含被拒的 verdict）
    CREATE TABLE IF NOT EXISTS audit (
      audit_id  TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kind      TEXT NOT NULL,
      job_id    TEXT,
      agent     TEXT,
      tool      TEXT,
      code      TEXT,
      reason    TEXT,
      payload   TEXT,
      trace_id  TEXT NOT NULL,
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit(tenant_id, at);

    -- M5 台账
    CREATE TABLE IF NOT EXISTS ledger (
      ledger_id   TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      job_id      TEXT NOT NULL,
      phase       TEXT NOT NULL,
      agent       TEXT,
      inputs_json TEXT NOT NULL DEFAULT '[]',
      outputs_json TEXT NOT NULL DEFAULT '[]',
      run_id      TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      ended_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_job ON ledger(job_id);

    -- M3 数据源准入登记
    CREATE TABLE IF NOT EXISTS sources (
      source_id       TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      name            TEXT NOT NULL,
      tier            TEXT NOT NULL,
      source_type     TEXT NOT NULL,
      owner           TEXT NOT NULL,
      auth_method     TEXT,
      contract_ref    TEXT,
      legal_approved  INTEGER NOT NULL DEFAULT 0,
      registered_by   TEXT NOT NULL,
      registered_at   TEXT NOT NULL,
      PRIMARY KEY (tenant_id, source_id)
    );

    -- M3 授权生命周期
    CREATE TABLE IF NOT EXISTS authz (
      authz_id     TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      granted_by   TEXT NOT NULL,
      valid_from   TEXT NOT NULL,
      valid_to     TEXT NOT NULL,
      scopes_json  TEXT NOT NULL DEFAULT '[]',
      status       TEXT NOT NULL,
      revoked_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_authz_lookup ON authz(tenant_id, source_id, status);
    `,
  },
  {
    id: 2,
    name: "knowledge",
    sql: `
    CREATE TABLE IF NOT EXISTS kb_docs (
      doc_id      TEXT PRIMARY KEY,
      tenant_id   TEXT,
      collection  TEXT NOT NULL,
      title       TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      mime        TEXT NOT NULL,
      byte_size   INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      chunk_id      TEXT PRIMARY KEY,
      doc_id        TEXT NOT NULL,
      collection    TEXT NOT NULL,
      tenant_id     TEXT,
      text          TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      source_type   TEXT NOT NULL,
      tier          TEXT NOT NULL,
      sample_size   INTEGER NOT NULL DEFAULT 0,
      published_at  TEXT NOT NULL,
      human_verified INTEGER NOT NULL DEFAULT 0,
      meta_json     TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_coll ON kb_chunks(collection, tenant_id);

    -- 词项倒排（BM25 用）；term 为中文 bigram 或英文小写词
    CREATE TABLE IF NOT EXISTS kb_terms (
      chunk_id TEXT NOT NULL,
      term     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_terms_term ON kb_terms(term);

    CREATE TABLE IF NOT EXISTS talents (
      talent_id       TEXT PRIMARY KEY,
      platform        TEXT NOT NULL,
      nickname        TEXT NOT NULL,
      category        TEXT NOT NULL,
      followers       INTEGER NOT NULL,
      engagement_rate REAL NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pricing (
      record_id      TEXT PRIMARY KEY,
      talent_id      TEXT NOT NULL,
      quoted_amount  REAL NOT NULL,
      actual_amount  REAL,
      currency       TEXT NOT NULL DEFAULT 'CNY',
      source_type    TEXT NOT NULL,
      observed_at    TEXT NOT NULL,
      human_verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_talent ON pricing(talent_id);

    -- 外部数据缓存（M4）
    CREATE TABLE IF NOT EXISTS external_cache (
      cache_key  TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    `,
  },
];

export function openDb(sqlitePath: string): Db {
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const raw = new DatabaseSync(sqlitePath);
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");

  const db: Db = {
    raw,
    exec(sql) {
      raw.exec(sql);
    },
    run(sql, ...params) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number | bigint };
    },
    get<T>(sql: string, ...params: SqlParam[]) {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SqlParam[]) {
      return raw.prepare(sql).all(...params) as T[];
    },
    tx<T>(fn: () => T): T {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* 已回滚 */
        }
        throw e;
      }
    },
    close() {
      raw.close();
    },
  };
  return db;
}

export function migrate(db: Db): { applied: number[]; skipped: number[] } {
  const done = new Set(db.all<{ id: number }>("SELECT id FROM schema_migrations").map((r) => r.id));
  const applied: number[] = [];
  const skipped: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) {
      skipped.push(m.id);
      continue;
    }
    db.tx(() => {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", m.id, m.name, new Date().toISOString());
    });
    applied.push(m.id);
  }
  return { applied, skipped };
}

export const stringify = (v: unknown): string => JSON.stringify(v ?? null);
export function parseJson<T>(v: string | null | undefined, fallback: T): T {
  if (v === null || v === undefined || v === "") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export const nowIso = (): string => new Date().toISOString();

/** 简易有序 UUID v7 风格 id（时间前缀，便于按时间排序与分页） */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rnd = Array.from({ length: 10 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  return `${prefix}_${ts}${rnd}`;
}
