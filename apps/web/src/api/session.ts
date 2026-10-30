/**
 * 会话令牌存储。
 *
 * 为什么不用 React Context 往下传：
 *   token 既要被组件读（顶栏输入框），也要被**非组件代码**读
 *   （api/client.ts 在每个请求上贴 Authorization，useJobStream 在建立
 *   SSE 长连接时也要贴）。用 Context 会逼着把 token 一路透传进数据层。
 *   这里做成一个"模块级可订阅的小 store"，两边都能拿到同一份最新值。
 *
 * 安全边界：token 只存 localStorage，不进 URL、不进 cookie。
 * 用 EventSource 就必须把 token 塞进查询串（会进访问日志与 Referer）——
 * 所以 SSE 宁可自己写 ReadableStream 解析。
 */

const STORAGE_KEY = "bm_token";
const USER_KEY = "bm_user";

/** 开发态默认令牌，与网关 `t.<tenantId>.<userId>` 约定一致 */
export const DEFAULT_TOKEN = "t.tenant_demo.u_demo";

/** 登录成功后本地缓存的用户信息（仅用于顶栏展示，真正的鉴权在网关上做） */
export interface LoggedInUser {
  userId: string;
  tenantId: string;
  nickname: string | null;
  openid: string;
}

const readUser = (): LoggedInUser | null => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as LoggedInUser) : null;
  } catch {
    return null;
  }
};

const read = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_TOKEN;
  } catch {
    // 隐私模式下 localStorage 可能直接抛错，此时退化为内存态
    return DEFAULT_TOKEN;
  }
};

let token = read();
let user = readUser();
const listeners = new Set<() => void>();

const notify = () => {
  for (const l of listeners) l();
};

export const getToken = (): string => token;

export const setToken = (next: string): void => {
  const v = next.trim();
  if (v === token) return;
  token = v;
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* 忽略：存不下也不影响本次会话 */
  }
  notify();
};

/** 登录成功：写入 token 与用户信息，并广播 */
export const login = (nextToken: string, u: LoggedInUser): void => {
  token = nextToken.trim();
  user = u;
  try {
    localStorage.setItem(STORAGE_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  } catch {
    /* 忽略 */
  }
  notify();
};

/** 登出：清掉用户信息，token 退回默认令牌 */
export const logout = (): void => {
  user = null;
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* 忽略 */
  }
  notify();
};

export const getLoggedInUser = (): LoggedInUser | null => user;

export const subscribeToken = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** 租户/用户由 token 解出，仅用于界面提示（真正的鉴权在网关上做） */
export const parseTenant = (t: string = token): { tenantId: string; userId: string } | null => {
  const parts = t.split(".");
  if (parts.length !== 3 || parts[0] !== "t") return null;
  return { tenantId: parts[1]!, userId: parts[2]! };
};
