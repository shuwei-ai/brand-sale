/**
 * DreamAuth 微信扫码登录 —— Open API 客户端（网关侧）。
 *
 * DreamAuth 是一个**第三方托管的开放平台**：后端拿 AK/SK 签名调它的 Open API，
 * 创建扫码会话 → 前端展示二维码 → 轮询状态 → 取授权结果（拿到 openid）。
 * 本模块只做「签名 + 三个端点」的薄封装，不含任何业务映射。
 *
 * 签名算法（照 DreamAuth 官方 open-api.md）：
 *   MD5(Method|Path|Timestamp|Nonce|PayloadJson|SecretKey)
 * 其中：
 *   - Method 大写；
 *   - Path 只含 URI path（不含域名、不含 query）；
 *   - PayloadJson 是 JSON.stringify 后的请求体；GET /status 签名的是
 *     虚拟 payload `{"sessionNo":"..."}`，而不是空串（官方坑点）；
 *   - Timestamp 为秒级，偏移超过 300s 会 401。
 *
 * ⚠️ secretKey 只允许在这里（后端进程）使用，绝不外传前端。
 * ⚠️ MD5 签名是 DreamAuth 服务端既定协议，本模块忠实实现之；这属于
 *    第三方平台的历史约束，不代表本系统推荐 MD5 用于自身安全场景。
 */

import { createHash, randomUUID } from "node:crypto";

export interface DreamAuthConfig {
  enabled: boolean;
  baseUrl: string;
  accessKey: string;
  secretKey: string;
  expireSeconds: number;
}

/** DreamAuth 返回的统一信封 */
interface Result<T> {
  code: number;
  msg: string;
  data: T;
}

export interface CreateSessionResult {
  code: number;
  msg: string;
  scene: string;
  sessionNo: string;
  qrcode: string; // data:image/png;base64,...
  expireAt: string;
  appCode: string;
}

export interface SessionStatusResult {
  sessionNo: string;
  scene: string;
  status: number; // 1 待扫 / 2 已扫待确认 / 3 已授权 / 4 取消 / 6 已消费 / 7 过期
  memberRole?: number;
  authTime?: string;
  expireAt: string;
}

export interface SessionResultResult {
  sessionNo: string;
  scene: string;
  status: number;
  openid: string;
  authToken: string;
  memberRole?: number;
  bizCode?: string;
  bizState?: string;
  targetType?: string;
  authTime?: string;
}

const OPEN_PATH = "/api/open/scan-login";

export class DreamAuthError extends Error {
  readonly code: string;
  constructor(message: string, code = "E-DREAMAUTH") {
    super(message);
    this.name = "DreamAuthError";
    this.code = code;
  }
}

export class DreamAuthClient {
  constructor(private readonly cfg: DreamAuthConfig) {}

  /** 是否可用（开关 + 凭据齐全） */
  get ready(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.accessKey && this.cfg.secretKey);
  }

  private sign(method: string, path: string, timestamp: string, nonce: string, payloadJson: string): string {
    const plain = `${method.toUpperCase()}|${path}|${timestamp}|${nonce}|${payloadJson}|${this.cfg.secretKey}`;
    return createHash("md5").update(plain, "utf8").digest("hex");
  }

  private headers(method: string, path: string, payload: unknown): Record<string, string> {
    const payloadJson = payload === undefined || payload === null ? "" : JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
    const sign = this.sign(method, path, timestamp, nonce, payloadJson);
    return {
      "X-Kite-AK": this.cfg.accessKey,
      "X-Kite-Timestamp": timestamp,
      "X-Kite-Nonce": nonce,
      "X-Kite-Sign": sign,
      "Content-Type": "application/json",
    };
  }

  private async call<T>(method: "GET" | "POST", path: string, payload: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.cfg.baseUrl}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: this.headers(method, path, payload),
        ...(payload !== undefined && payload !== null ? { body: JSON.stringify(payload) } : {}),
      });
    } catch (e) {
      throw new DreamAuthError(`无法连接 DreamAuth：${e instanceof Error ? e.message : String(e)}`, "E-DREAMAUTH-NET");
    }

    const text = await res.text();
    let body: Result<T>;
    try {
      body = JSON.parse(text) as Result<T>;
    } catch {
      throw new DreamAuthError(`DreamAuth 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, "E-DREAMAUTH-500");
    }
    if (!res.ok || body.code !== 200) {
      throw new DreamAuthError(`DreamAuth 返回错误（HTTP ${res.status} / code ${body.code}）：${body.msg}`, `E-DREAMAUTH-${body.code ?? res.status}`);
    }
    return body.data;
  }

  /** 创建扫码会话，返回 sessionNo + 二维码 base64 */
  async createSession(bizState: string): Promise<CreateSessionResult> {
    return this.call<CreateSessionResult>("POST", `${OPEN_PATH}/session/create`, {
      bizCode: "LOGIN",
      bizState,
      targetType: "user",
      expireSeconds: this.cfg.expireSeconds,
    });
  }

  /** 查询会话状态 */
  async getStatus(sessionNo: string): Promise<SessionStatusResult> {
    // 官方坑点：GET 的签名 payload 是 {"sessionNo":...}，不是空串
    return this.call<SessionStatusResult>("GET", `${OPEN_PATH}/session/status`, { sessionNo }, { sessionNo });
  }

  /** 取授权结果（默认 consume=true，一次性） */
  async getResult(sessionNo: string): Promise<SessionResultResult> {
    return this.call<SessionResultResult>("POST", `${OPEN_PATH}/session/result`, { sessionNo, consume: true });
  }
}
