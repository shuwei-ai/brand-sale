#!/usr/bin/env node
/**
 * 假 `xhs` CLI —— **测试夹具，不是真实采集工具**
 *
 * ── 它为什么存在 ──────────────────────────────────────────────
 *
 * 小红书只读代理的价值有一半在**失败路径**上：未登录 / 登录态过期 / 验证码 /
 * IP 限流 / 签名失败 / 本机没装 CLI。这几条如果只在 mock 的 `?__fail=` 开关上验，
 * 验到的是"适配器拿到一个标准码之后怎么翻译"，而没验到"代理能不能从 CLI 那堆
 * 不稳定的输出里认出这是哪一种失败"—— 后者恰恰是真实环境里最容易出问题的一层。
 *
 * 而要在真的跑一遍这些路径，就得先 `uv tool install xiaohongshu-cli` 再扫码登录，
 * 这既污染部署机、又没法在 CI 里复现。所以用一个**可控的**假 CLI 顶上。
 *
 * ── 假数据自己声明自己是假的 ──────────────────────────────────
 *
 * 成功响应里带 `_lab: { mock: true }`，代理会透传、适配器据此把
 * `provenance.synthetic` 置为 true。这是本项目的底线：宁可数据难看，
 * 也不能让夹具产出的数字看起来像真实采集。
 *
 * ── 场景由入参里的关键词决定（见 tests/xhs-proxy.test.ts）──────
 *
 *   ...expired    → 只给一句中文报错、**不给错误码**（考验归一层）
 *   ...captcha    → 给一个非契约的码 E_RISK，靠 message 认出验证码
 *   ...blocked    → 不给 JSON，只在 stderr 打限流文案 + 非零退出码
 *   ...noauth     → 无 JSON，stderr 打英文 "no a1 cookie ... not logged in"
 *   ...signfail   → 非契约码 E_SIGN，message 说签名
 *   ...canonical  → 直接给契约里的码 session_expired（应被原样尊重）
 *   ...garbage    → 退出码非零且输出无法识别（应如实报"认不出来"）
 *   ...preamble   → JSON 前后夹日志行（考验信封提取）
 *   其它           → 成功响应
 */

const op = process.argv[2] ?? "";
const input = process.argv[3] ?? "";

const say = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
const die = (text, code) => {
  process.stderr.write(text + "\n");
  process.exit(code);
};

const knocks = (token) => input.includes(token);

/* ── 失败场景 ─────────────────────────────────────────── */

if (knocks("expired")) {
  // 真实 CLI 常见形态：有 ok:false、有 message，但**没有 code**
  say({ ok: false, error: { message: "登录已过期，请重新登录后再试" } });
  process.exit(0);
}

if (knocks("captcha")) {
  // 码是它自己起的名字，契约里没有 —— 归一层只能靠 message
  say({ ok: false, error: { code: "E_RISK", message: "触发验证码，请人工在浏览器完成验证" } });
  process.exit(0);
}

if (knocks("blocked")) {
  // 最麻烦的形态：没有 JSON，只有 stderr 文案 + 非零退出码
  die("❌ 请求过于频繁，IP 已被限流 (429)", 3);
}

if (knocks("noauth")) {
  die("Error: no a1 cookie found, not logged in", 2);
}

if (knocks("signfail")) {
  say({ ok: false, error: { code: "E_SIGN", message: "签名校验失败，可能版本过旧" } });
  process.exit(0);
}

if (knocks("canonical")) {
  say({ ok: false, error: { code: "session_expired", message: "cookie expired" } });
  process.exit(0);
}

if (knocks("garbage")) {
  die("Ouch. Something went horribly wrong.", 7);
}

/* ── 成功场景 ─────────────────────────────────────────── */

// 真实 CLI 会在 JSON 前后打版本提示 / 耗时日志
if (knocks("preamble")) process.stdout.write("发现新版本 v1.2.3，可用 uv tool upgrade 升级\n");
process.stdout.write("[xhs] 人类化延迟 1240ms\n");

const NOTE = {
  note_id: input,
  title: "换季护肤的 5 个坑，我全踩过",
  desc: "干皮姐妹看过来……",
  type: "normal",
  user: { user_id: "u_8842", nickname: "青禾护肤手记" },
  interact_info: { liked_count: 12400, collected_count: 8900, comment_count: 431 },
  // 小红书常把计数写成 "1.2万"，归一化要能认
  tags: ["护肤", "换季", "干皮"],
  time: "2026-09-26T00:00:00Z",
  _note: "本字段来自测试夹具，不是真实采集",
};

const payloads = {
  read: { ok: true, _lab: { mock: true }, data: { note: NOTE } },
  user: {
    ok: true,
    _lab: { mock: true },
    data: {
      user: {
        user_id: input,
        nickname: "青禾护肤手记",
        desc: "护肤 / 成分党",
        ip_location: "上海",
        interact_info: { fans: "1.2万", follows: 186, note_count: 84, liked: "3.4万" },
      },
    },
  },
  comments: {
    ok: true,
    _lab: { mock: true },
    data: {
      comments: [
        { comment_id: "c1", content: "油皮能用吗", user: { nickname: "小满" }, like_count: 12, ip_location: "广东", create_time: "2026-09-27T01:00:00Z", sub_comment_count: 3 },
        { comment_id: "c2", content: "已入同款", user: { nickname: "阿吉" }, like_count: 4, ip_location: "北京", create_time: "2026-09-27T02:00:00Z", sub_comment_count: 0 },
      ],
    },
  },
  "user-posts": {
    ok: true,
    _lab: { mock: true },
    data: { notes: [NOTE, { ...NOTE, note_id: input + "-2", title: "空瓶记录", interact_info: { liked_count: 3012, collected_count: 1200, comment_count: 55 } }] },
  },
};

const payload = payloads[op];
if (!payload) die(`未知子命令 ${op}（夹具只实现只读四件套）`, 64);

process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
