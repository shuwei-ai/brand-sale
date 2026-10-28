#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务端扫码登录执行器（brandsale 自有代码，**不属于** MediaCrawler 内核）。

为什么单独一个脚本，而不是改内核的 `media_platform/*/login.py`：

  1. 内核的登录流程是**交互式**的 —— 拿到二维码后调 `show_qrcode()` 打开本机看图器，
     等人扫。服务器上没有 DISPLAY，这一步必然失败，而它跑在 `run_in_executor` 里，
     异常会被吞掉，表现为「卡住不动、日志无异常」。
  2. 内核的登录与采集**共用同一个一次性子进程**，扫码 60–120s 会把采集队列堵死。
     这里独立进程 + 独立生命周期，采集队列照常跑。

它只做两件**只读**的事：
  · `--mode login`  ：起无头浏览器 → 取二维码（base64）→ 等扫码 → 落 profile
  · `--mode check`  ：起无头浏览器读该平台 profile，判断「当前是否真的登录」

输出约定：**stdout 只吐单行 JSON 事件**（Node 侧逐行解析），人类可读日志一律走 stderr。

profile 目录与内核**完全同一份**（`<coreDir>/browser_data/cdp_<platform>_user_data_dir`），
这是整个方案能成立的关键：这里扫完码，采集子进程下次启动直接复用登录态。

用法：
    python login_runner.py --mode check --platforms xhs,bili
    python login_runner.py --mode login --platform xhs --timeout 180
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

PLATFORMS = ("xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu")

# 手动导 cookie 时，把 `name=value` 字符串落成浏览器 cookie 用的域名。
# 与内核 `login_by_cookies` 的硬编码 `.douyin.com` 不同，这里每个平台用自己
# 真实的主域 —— cookie 的 domain 写错会「写入成功但采集侧永远读不到」。
# 注意带不带点：Playwright 的 add_cookies 里 `domain` 以 `.` 开头表示「子域也生效」。
COOKIE_DOMAINS: Dict[str, str] = {
    "xhs": ".xiaohongshu.com",
    "dy": ".douyin.com",
    "ks": ".kuaishou.com",
    "bili": ".bilibili.com",
    "wb": ".weibo.com",
    "tieba": ".baidu.com",
    "zhihu": ".zhihu.com",
}

# 扫码登录过程里，平台侧只要出现下列任一 cookie，且值与扫码前不同，就认为换发了新会话
SPECS: Dict[str, Dict[str, Any]] = {
    "xhs": {
        "name": "小红书",
        "entry": "https://www.xiaohongshu.com",
        # 首页不一定自动弹登录框，弹不出来就点右上角「登录」
        "click": ["xpath=//*[@id='app']/div[1]/div[2]/div[1]/ul/div[1]/button"],
        "qr": {"kind": "img", "selector": "xpath=//img[@class='qrcode-img']"},
        "markers": ["web_session"],
        "probe": {"kind": "dom", "url": "https://www.xiaohongshu.com/explore",
                  "js": "() => !!document.querySelector(\"a[href*='/user/profile/']\")"},
    },
    "dy": {
        "name": "抖音",
        "entry": "https://www.douyin.com",
        "click": ["xpath=//p[text()='登录']"],
        "qr": {"kind": "img", "selector": "xpath=//div[@id='animate_qrcode_container']//img"},
        "markers": ["LOGIN_STATUS", "sessionid", "sessionid_ss"],
        "localstorage": ("HasUserLogin", "1"),
        # 内核 pong()/check_login_state 认「LOGIN_STATUS==1 或 HasUserLogin==1」，
        # 但这两个都是前端 JS 运行时才写的，手动导 cookie 天然没有。用户粘贴了
        # 有效 sessionid 时，这里补一个 LOGIN_STATUS=1，让内核与探活层一致判 bound。
        "auto_marker": {"if_present": ["sessionid", "sessionid_ss"], "set": {"LOGIN_STATUS": "1"}},
    },
    "ks": {
        "name": "快手",
        "entry": "https://www.kuaishou.com",
        # 入口文案是「立即登录」，不是「登录」（真机：侧栏 .sidebar-login-b）。只写
        # 「登录」会点不到 → 弹层不出现 → 取码超时，用户只看到一行 Timeout。
        "click": ["text=立即登录", "xpath=//span[contains(@class,'sidebar-login')]",
                  "xpath=//p[text()='登录']"],
        # 弹层里的码是 data URL，且**没有 class / id**；页面其它图片都是 https 的。
        # 不能用 selector 取第一张：弹层刚出现时会先渲染一张更小的骨架图
        # （实测抓到 298 字符的假码），所以按 naturalWidth 挑最大的那张。
        "qr": {"kind": "js", "js": """() => {
          const imgs = [...document.querySelectorAll('img')]
            .filter(i => (i.src || '').startsWith('data:image/png;base64')
                      && (i.naturalWidth || 0) >= 100)
            .sort((a, b) => (b.naturalWidth || 0) - (a.naturalWidth || 0));
          return imgs[0] ? imgs[0].src : '';
        }"""},
        "markers": ["passToken"],
    },
    "bili": {
        "name": "B站",
        "entry": "https://www.bilibili.com",
        "click": [".header-avatar-unlogin-entry",
                  ".right-entry__outside.go-login-btn .header-login-entry"],
        "qr": {"kind": "img", "selector": "//div[@class='login-scan-box']//img"},
        "markers": ["SESSDATA"],
        "probe": {"kind": "api", "url": "https://api.bilibili.com/x/web-interface/nav",
                  "json": ("data", "isLogin"), "expect": True},
    },
    "wb": {
        "name": "微博",
        "entry": "https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog",
        "click": [],
        "qr": {"kind": "img", "selector": "xpath=//img[@class='w-full h-full']"},
        "markers": ["SSOLoginState", "WBPSESS"],
        "probe": {"kind": "api", "url": "https://m.weibo.cn/api/config",
                  "json": ("data", "login"), "expect": True},
    },
    "tieba": {
        "name": "贴吧",
        "entry": "https://tieba.baidu.com",
        "click": ["xpath=//div[contains(@class,'login-btn')]", "xpath=//li[@class='u_login']"],
        "qr": {"kind": "img", "selector": "xpath=//img[@class='tang-pass-qrcode-img']",
               # 弹窗里的 <img> 先给 loading.gif 占位，等 src 换成真码再取（真机踩过）
               "ready_js": "() => { const i = document.querySelector('img.tang-pass-qrcode-img');"
                           " return !!i && /passport\\.baidu\\.com\\/v2\\/api\\/qrcode/.test(i.src || ''); }"},
        "markers": ["STOKEN", "PTOKEN"],
        "probe": {"kind": "api", "url": "https://tieba.baidu.com/dc/common/tbs",
                  "json": ("is_login",), "expect": 1},
    },
    "zhihu": {
        "name": "知乎",
        "entry": "https://www.zhihu.com",
        "click": ["xpath=//button[contains(.,'登录')]", "xpath=//div[contains(@class,'SignFlow')]//button"],
        "qr": {"kind": "canvas", "selector": "canvas.Qrcode-qrcode"},
        "markers": ["z_c0"],
        "probe": {"kind": "api", "url": "https://www.zhihu.com/api/v4/me",
                  "expect_status": 200},
    },
}

# 反自动化指纹：内核只对抖音做了这一步（`add_stealth_script`），七个平台统一加上，
# 否则无头模式在 server 上更容易被判成机器人。**只影响浏览器指纹，不碰平台写操作。**
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = window.chrome || { runtime: {} };
"""

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def log(msg: str) -> None:
    print(f"[login] {msg}", file=sys.stderr, flush=True)


def emit(**payload: Any) -> None:
    """单行 JSON 事件。Node 侧 `readline` 逐行解析，所以**绝不能多行**。"""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def cookie_map(cookies: List[Dict[str, Any]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for c in cookies:
        name = c.get("name")
        if isinstance(name, str):
            out[name] = str(c.get("value") or "")
    return out


def launch_args() -> List[str]:
    # `--no-sandbox` 只在 root（容器里的常态）下加：非 root 环境留着会削弱隔离
    args = [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",  # 容器 /dev/shm 默认 64MB，不加会随机崩
        "--lang=zh-CN",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args += ["--no-sandbox", "--disable-setuid-sandbox"]
    return args


# 启动策略（按顺序尝试）。为什么要多档：
#   · playwright ≥1.49 的 `headless=True` 默认用 **chrome-headless-shell**，它和完整
#     chromium 是两个独立产物 —— 只装了一个时就会报 "Executable doesn't exist"；
#   · `channel="chromium"` 用完整 chromium 跑新无头模式，指纹也更接近真实浏览器；
#   · 最后兜底本机装的 Chrome（容器里通常没有，本机调试常见）。
LAUNCH_STRATEGIES: List[Dict[str, Any]] = [
    {"label": "chromium(headless=new)", "kwargs": {"channel": "chromium"}},
    {"label": "chromium(headless-shell)", "kwargs": {}},
    {"label": "system-chrome", "kwargs": {"channel": "chrome"}},
]


async def launch_ctx(p, profile_dir: str, headless: bool):
    last: Optional[Exception] = None
    for strat in LAUNCH_STRATEGIES:
        try:
            ctx = await p.chromium.launch_persistent_context(
                user_data_dir=profile_dir,
                headless=headless,
                args=launch_args(),
                user_agent=DEFAULT_UA,
                viewport={"width": 1280, "height": 900},
                locale="zh-CN",
                **strat["kwargs"],
            )
            log(f"浏览器启动成功：{strat['label']}")
            return ctx
        except Exception as e:  # noqa: BLE001 — 换下一种策略
            last = e
            log(f"浏览器启动失败（{strat['label']}）：{str(e).splitlines()[0]}")
    raise last if last else RuntimeError("没有可用的浏览器启动策略")


async def with_browser(spec: Dict[str, Any], platform: str, profile_dir: str, headless: bool, fn):
    """起一个 persistent context，跑完关掉。profile 与内核共用同一份目录。"""
    from playwright.async_api import async_playwright

    os.makedirs(profile_dir, exist_ok=True)
    async with async_playwright() as p:
        ctx = await launch_ctx(p, profile_dir, headless)
        try:
            await ctx.add_init_script(STEALTH_JS)
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            return await fn(ctx, page, spec)
        finally:
            try:
                await ctx.close()
            except Exception:  # noqa: BLE001 — 关闭失败不该覆盖真正的错误
                pass


async def first_visible(page, selectors: List[str], timeout_ms: int = 5000) -> Optional[str]:
    """依次试多个选择器，返回第一个能点到的。平台改版时靠这个兜住。"""
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=timeout_ms)
            return sel
        except Exception:  # noqa: BLE001
            continue
    return None


async def detect_block(page) -> Optional[str]:
    """页面被风控挡住时，给一句人能看懂的原因（拿不到二维码的常见真因）。

    实测两种，成因不同、出路也不同，混成一句用户就没法自救：

      · **人机验证**：抖音在无头 + 新 profile 下打开首页，直接弹「请完成下列验证后继续」
        的拼图滑块（iframe 指向 `rmc.bytedance.com/verifycenter/captcha`），页面上根本
        没有登录按钮。此时 `wait_for_selector` 只抛一行 Timeout，用户看不出为什么失败。
      · **IP 风控**：小红书会把整站重定向到 `/website-login/error?error_code=300012
        &error_msg=IP存在风险…`，连二维码接口都不让调 —— 换账号没用，得换出口 IP。
    """
    try:
        kind = await page.evaluate("""() => {
          const u = location.href || '';
          if (/website-login\\/error|error_code=\\d+/.test(u)) return 'ip';
          const f = [...document.querySelectorAll('iframe')]
            .find(i => /verifycenter|captcha|verify/i.test(i.src || ''));
          if (f) return 'captcha';
          const t = (document.body && document.body.innerText) || '';
          if (/请完成下列验证|拖动.{0,6}滑块|安全验证|异常流量|操作频繁|IP存在风险/.test(t)) {
            return 'captcha';
          }
          return '';
        }""")
    except Exception:  # noqa: BLE001
        return None
    if kind == "captcha":
        return ("平台返回了人机验证（滑块/验证码）页面，无头浏览器无法完成验证，因此拿不到二维码。"
                "该平台需要先在本机有头浏览器里登录一次，再把 profile 复用给采集侧")
    if kind == "ip":
        return ("平台按出口 IP 判定了风险并拦下登录（小红书 error_code 300012），"
                "更换网络/IP 后用有头浏览器登录一次；换账号无效")
    return None


async def extract_qr(ctx, page, spec: Dict[str, Any], timeout_ms: int = 20000) -> str:
    """取二维码，归一化成 `data:image/png;base64,...`。

    三种形态都要覆盖（各平台不一样，读内核实现确认过）：
      · <img src="https://...">  → 需要下载再 base64（微博/贴吧/B站/快手/抖音/小红书）
      · <img src="data:image/..."> → 直接用
      · <canvas>                 → 元素截图（知乎）
    """
    qr = spec["qr"]
    if qr["kind"] == "js":
        # 页面结构既无 class 也无 id、且弹层刚出现时有占位小图时（快手），
        # 按「尺寸最大的 data 图」定位：直接问页面要 src，比 `nth=0` 稳得多。
        # 实测不这么做会抓到 125px 之前的骨架图，base64 只有 298 字符，用户扫不出来。
        handle = await page.wait_for_function(qr["js"], timeout=timeout_ms)
        src = await handle.json_value()
        if not isinstance(src, str) or not src:
            raise RuntimeError("页面没有找到可用的二维码图像")
        if src.startswith("data:image"):
            return src
        resp = await ctx.request.get(src)
        if not resp.ok:
            raise RuntimeError(f"下载二维码失败：HTTP {resp.status}")
        return "data:image/png;base64," + base64.b64encode(await resp.body()).decode("ascii")

    if qr["kind"] == "canvas":
        el = await page.wait_for_selector(qr["selector"], timeout=timeout_ms)
        shot = await el.screenshot()
        return "data:image/png;base64," + base64.b64encode(shot).decode("ascii")

    if qr.get("ready_js"):
        try:
            await page.wait_for_function(qr["ready_js"], timeout=timeout_ms)
        except Exception:  # noqa: BLE001 — 等不到就照旧取，由外层判断是否为空
            log("二维码 ready 条件超时，尝试直接取图")

    el = await page.wait_for_selector(qr["selector"], timeout=timeout_ms)
    src = await el.get_attribute("src") or ""
    if src.startswith("data:image"):
        return src
    if not src:
        raise RuntimeError("二维码 <img> 的 src 为空")
    resp = await ctx.request.get(src)
    if not resp.ok:
        raise RuntimeError(f"下载二维码失败：HTTP {resp.status}")
    body = await resp.body()
    return "data:image/png;base64," + base64.b64encode(body).decode("ascii")


async def is_logged_in(ctx, page, spec: Dict[str, Any], before: Dict[str, str],
                       require_change: bool, before_ls: Optional[str] = None) -> bool:
    """登录判定：marker cookie 出现或换发（`require_change` 时要求值真的变了）。

    为什么要求「值变了」而不是「存在」：profile 里残留一份**过期** cookie 的平台很常见
    （B 站尤其），只判存在会把"看起来已登录"当成"登录成功"。

    localStorage 标记（目前只有抖音 `HasUserLogin`）**只在 `require_change` 且值相对扫码前
    发生变化时才算数**。原因（真机踩过）：

      · profile 里残留 `HasUserLogin=1` 是常态，而会话 cookie（`sessionid` /
        `LOGIN_STATUS`）已被平台清掉 —— 此时「本地标记还在」不代表登录态还在；
      · 若在 `require_change` 下只判 `got == want`，扫码循环**第一轮（2 秒内）就会误报
        「扫码成功」**，用户根本没扫，采集侧却拿到 0 条数据。

    所以本地标记只能当"变化证据"，不能当"存在证据"。
    """
    cm = cookie_map(await ctx.cookies())
    for name in spec["markers"]:
        cur = cm.get(name) or ""
        if not cur:
            continue
        if not require_change or cur != (before.get(name) or ""):
            return True

    ls = spec.get("localstorage")
    if ls and require_change:
        key, want = ls
        try:
            got = await page.evaluate("(k) => window.localStorage.getItem(k)", key)
            if got == want and (before_ls or "") != want:
                return True
        except Exception:  # noqa: BLE001 — about:blank 等没有 localStorage 的页面
            pass
    return False


async def read_local_marker(page, spec: Dict[str, Any]) -> Optional[str]:
    """读 localStorage 登录标记的当前值（读不到返回 None，不猜）。"""
    ls = spec.get("localstorage")
    if not ls:
        return None
    try:
        return await page.evaluate("(k) => window.localStorage.getItem(k)", ls[0])
    except Exception:  # noqa: BLE001
        return None


async def api_probe(ctx, probe: Dict[str, Any]) -> Optional[bool]:
    """接口级探活：能判就判，判不了返回 None（不猜）。"""
    try:
        resp = await ctx.request.get(probe["url"], timeout=15_000)
    except Exception as e:  # noqa: BLE001
        log(f"探活请求失败：{e}")
        return None
    if "expect_status" in probe:
        return resp.status == probe["expect_status"]
    try:
        data = await resp.json()
    except Exception:  # noqa: BLE001
        return None
    cur: Any = data
    for key in probe["json"]:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur == probe["expect"]


async def probe_state(ctx, page, spec: Dict[str, Any]) -> Dict[str, str]:
    """在**已有登录 cookie** 的前提下，判断这份会话是否真的还有效。

    返回 `{state, confidence, detail}`：`bound` / `unbound` / `unverified`。
    `unverified` 是诚实的中间态（只有 cookie、没有可信探活手段），**不冒充已绑定**。
    """
    probe = spec.get("probe")
    if probe and probe["kind"] == "api":
        ok = await api_probe(ctx, probe)
        if ok is None:
            return {"state": "unverified", "confidence": "cookie",
                    "detail": "有登录 cookie，但接口探活失败（网络或风控），无法确认"}
        return {"state": "bound" if ok else "unbound", "confidence": "verified",
                "detail": "接口探活：已登录" if ok else "接口探活：cookie 已失效"}

    if probe and probe["kind"] == "dom":
        try:
            await page.goto(probe["url"], wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(2500)
            ok = bool(await page.evaluate(probe["js"]))
            return {"state": "bound" if ok else "unbound", "confidence": "verified",
                    "detail": "页面判定：已登录" if ok else "页面判定：未登录"}
        except Exception as e:  # noqa: BLE001
            return {"state": "unverified", "confidence": "cookie", "detail": f"页面判定失败：{e}"}

    # 抖音有 localStorage 标记，命中即已登录；命中不了再退回 marker cookie 值判断
    if spec.get("localstorage"):
        # 内核 `check_login_state` 的权威判断顺序是：localStorage `HasUserLogin` →
        # cookie `LOGIN_STATUS == "1"`。这里对齐：cookie 里带 `LOGIN_STATUS=1` 也算
        # bound，否则「用户填了有效 cookie 却永远显示待验证」。
        cm = cookie_map(await ctx.cookies())
        if cm.get("LOGIN_STATUS") == "1":
            return {"state": "bound", "confidence": "cookie",
                    "detail": "登录标记 cookie（LOGIN_STATUS=1）已就位"}
        return {"state": "unverified", "confidence": "cookie",
                "detail": "有登录 cookie，但 localStorage 标记未命中（可能是残留会话）"}

    return {"state": "unverified", "confidence": "cookie",
            "detail": "有登录 cookie，但该平台无稳定探活接口；以实际采集是否成功为准"}


async def do_check(args, platform: str) -> Dict[str, Any]:
    """判断当前 profile 是否真的登录。

    两段式：先看 marker cookie 在不在（不在就确定未登录），在的话再用平台自己的
    接口 / DOM 验一次 —— cookie 存在 ≠ 有效。
    """
    spec = SPECS[platform]
    profile_dir = os.path.join(args.browser_data, f"cdp_{platform}_user_data_dir")
    result: Dict[str, Any] = {
        "platform": platform, "name": spec["name"], "profileDir": profile_dir,
        "profileExists": os.path.isdir(profile_dir),
    }

    async def body(ctx, page, spec_):
        # **必须先导航再读 cookie**：persistent context 启动时并不会把 profile 里的
        # cookie 全部灌进内存，第一次导航到该域才会加载。不导航直接 `cookies()` 会得到
        # 空数组 —— 实测把「已登录的小红书」误判成「未绑定」。
        try:
            await page.goto(spec_["entry"], wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(1500)
        except Exception as e:  # noqa: BLE001
            log(f"导航失败（继续判 cookie）：{e}")

        cm = cookie_map(await ctx.cookies())
        present = [n for n in spec_["markers"] if (cm.get(n) or "")]
        result["cookiePresent"] = present
        if not present:
            # 只有本地标记、没有会话 cookie = 会话已失效。这条要说清楚，
            # 否则用户看到「我明明绑过」却显示未绑定（抖音 profile 里 HasUserLogin
            # 常年残留 "1"，而 sessionid / LOGIN_STATUS 已被平台清掉）。
            ls = spec_.get("localstorage")
            marker = await read_local_marker(page, spec_) if ls else None
            stale = bool(ls) and marker == ls[1]
            result.update(
                state="unbound", confidence="cookie",
                detail=("登录会话已失效：本地留着登录标记，但没有会话 cookie，请重新扫码"
                        if stale else "profile 里没有该平台的登录 cookie"),
            )
            return result

        result.update(await probe_state(ctx, page, spec_))
        return result

    try:
        return await with_browser(spec, platform, profile_dir, args.headless, body)
    except Exception as e:  # noqa: BLE001
        result.update(state="error", detail=f"浏览器启动失败：{e}")
        return result


async def do_login(args, platform: str) -> int:
    spec = SPECS[platform]
    profile_dir = os.path.join(args.browser_data, f"cdp_{platform}_user_data_dir")
    deadline = time.monotonic() + args.timeout
    started = time.time()

    async def body(ctx, page, spec_):
        await page.goto(spec_["entry"], wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(1500)

        before = cookie_map(await ctx.cookies())
        before_ls = await read_local_marker(page, spec_)

        # 已经登录（profile 还有效）：不必再扫。但**不能只看登录痕迹**：
        #   · 小红书 profile 里会留一份过期的 web_session（只看 cookie 存在 = 假阳性）；
        #   · 抖音 profile 里常年残留 localStorage `HasUserLogin=1`，而 `sessionid` /
        #     `LOGIN_STATUS` 早已被平台清掉（实测 cookiePresent 为空）。
        # 凭痕迹就宣称「登录态仍然有效」，用户会看到「已绑定」却在采集时拿到 0 条 ——
        # 这正是本页最不能犯的错。所以：**只有探活明确判 bound 才算已登录**，
        # 没有探活手段的平台一律照常出码（扫码是幂等的，平台侧会直接提示已登录）。
        if await is_logged_in(ctx, page, spec_, before, require_change=False, before_ls=before_ls):
            probe = spec_.get("probe")
            if probe:
                verdict = await probe_state(ctx, page, spec_)
                if verdict["state"] == "bound":
                    emit(event="already_logged_in", platform=platform)
                    return 0
                log(f"有登录痕迹但校验未通过（{verdict['detail']}），继续取二维码")
            else:
                log("有登录痕迹但该平台无探活手段，不判定为已登录，继续取二维码")
            await page.goto(spec_["entry"], wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(1200)

        got_qr = False
        last_refresh = 0.0
        while time.monotonic() < deadline:
            if await is_logged_in(ctx, page, spec_, before, require_change=True, before_ls=before_ls):
                emit(event="logged_in", platform=platform,
                     profileDir=profile_dir, seconds=round(time.time() - started, 1))
                # 给平台侧一点时间把 cookie 写全，再关闭上下文
                await page.wait_for_timeout(1500)
                return 0

            now = time.monotonic()
            if not got_qr or now - last_refresh > args.qr_refresh:
                for sel in spec_.get("click") or []:
                    try:
                        await page.locator(sel).first.click(timeout=1500)
                        await page.wait_for_timeout(1200)
                        break
                    except Exception:  # noqa: BLE001 — 弹窗可能已经自己弹出来了
                        continue
                try:
                    data_url = await extract_qr(ctx, page, spec_, timeout_ms=15000 if not got_qr else 6000)
                    emit(event="qr", platform=platform, dataUrl=data_url,
                         expiresIn=args.qr_ttl, at=int(time.time() * 1000))
                    got_qr = True
                    last_refresh = now
                except Exception as e:  # noqa: BLE001
                    if not got_qr:
                        log(f"取二维码失败：{e}")
                        blocked = await detect_block(page)
                        emit(event="failed", platform=platform,
                             error=blocked or f"未能在页面上找到二维码：{e}")
                        return 3
                    log(f"二维码刷新失败（沿用上一张）：{e}")

            await asyncio.sleep(2.0)

        emit(event="timeout", platform=platform, seconds=args.timeout)
        return 2

    try:
        return await with_browser(spec, platform, profile_dir, args.headless, body)
    except Exception as e:  # noqa: BLE001
        emit(event="failed", platform=platform, error=f"浏览器启动失败：{e}")
        return 4


def parse_cookie_str(raw: str) -> List[Dict[str, str]]:
    """把 `name=value; name2=value2` 或 `a=b\nc=d` 解析成 cookie 列表。

    兼容三种用户可能粘贴的形态：
      · 浏览器 DevTools 复制的 `Cookie:` 请求头（分号分隔）；
      · F12 → Application → Cookies 里手动拼的 `k=v` 多行；
      · 单个 `k=v`。
    只认 `name=value` 形，其它片段（注释、空行）静默跳过，不让一个脏行毁掉整批。
    """
    out: List[Dict[str, str]] = []
    for piece in raw.replace("\n", ";").replace("\r", ";").split(";"):
        piece = piece.strip()
        if not piece or "=" not in piece:
            continue
        name, _, value = piece.partition("=")
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        if not name:
            continue
        # 去重：同名后者覆盖前者
        for item in out:
            if item["name"] == name:
                item["value"] = value
                break
        else:
            out.append({"name": name, "value": value})
    return out


async def do_set_cookie(args, platform: str) -> int:
    """把用户手动粘贴的 cookie 写进该平台 profile，然后探活确认是否真的生效。

    这是「扫码被风控挡住」时的兜底路径：用户在本机浏览器登录后复制 cookie，
    前端提交到这里，落进与内核共用的 profile，采集侧下次启动直接复用。
    与扫码不同，这里**不换发新会话**，只是把「已有的会话」搬进来 —— 所以
    落盘后必须探活，否则可能把一份过期 cookie 谎报成「已绑定」。
    """
    spec = SPECS[platform]
    profile_dir = os.path.join(args.browser_data, f"cdp_{platform}_user_data_dir")
    domain = COOKIE_DOMAINS[platform]
    cookies = parse_cookie_str(args.cookie)
    if not cookies:
        emit(event="failed", platform=platform, error="cookie 为空或无法解析出任何 name=value")
        return 4

    async def body(ctx, page, spec_):
        # add_cookies 要求 domain 已可访问，否则 Chrome 会静默丢弃。先导航到 entry
        # 把域「激活」，再写入。这跟 do_check 里「必须先导航再读 cookie」是同一道理。
        try:
            await page.goto(spec_["entry"], wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(1000)
        except Exception as e:  # noqa: BLE001
            log(f"导航失败（仍尝试写 cookie）：{e}")

        # auto_marker：某些平台（抖音）内核认的登录标记（LOGIN_STATUS）是前端 JS
        # 运行时产物，手动导 cookie 天然没有。用户粘贴了有效 sessionid 时，自动补
        # 上这个 marker，让内核 pong() 与探活层一致判 bound（见 SPECS.dy.auto_marker）。
        auto = spec_.get("auto_marker")
        if auto:
            names = {c["name"] for c in cookies}
            if any(p in names for p in auto.get("if_present", [])):
                for mk, mv in auto.get("set", {}).items():
                    if mk not in names:
                        cookies.append({"name": mk, "value": mv})

        # 每个 cookie 都带上主域；个别平台（贴吧 .baidu.com）跨域较宽，照主域写即可。
        to_add = [{**c, "domain": domain, "path": "/"} for c in cookies]
        await ctx.add_cookies(to_add)

        # 写完后立刻探活，把「cookie 是否真的有效」这一关键信息带回给前端。
        cm = cookie_map(await ctx.cookies())
        present = [n for n in spec_["markers"] if (cm.get(n) or "")]
        if not present:
            emit(event="status", platform=platform, name=spec_["name"],
                 state="unbound", confidence="cookie",
                 detail="cookie 已写入，但未检测到登录标记（sessionid 等），可能已过期")
            return 1

        verdict = await probe_state(ctx, page, spec_)
        emit(event="status", platform=platform, name=spec_["name"],
             cookiePresent=present, **verdict)
        return 0 if verdict["state"] == "bound" else 1

    try:
        return await with_browser(spec, platform, profile_dir, args.headless, body)
    except Exception as e:  # noqa: BLE001
        emit(event="failed", platform=platform, error=f"浏览器启动失败：{e}")
        return 4


def parse_args(argv: Optional[List[str]] = None):
    p = argparse.ArgumentParser(description="brandsale 服务端扫码登录执行器")
    p.add_argument("--mode", required=True, choices=("login", "check", "cookie"))
    p.add_argument("--platform", default="", help="login/cookie 模式必填")
    p.add_argument("--platforms", default="", help="check 模式：逗号分隔，或 all")
    p.add_argument("--browser-data", dest="browser_data", default="",
                   help="profile 根目录（默认 ./browser_data，与内核一致）")
    p.add_argument("--headless", default="true")
    p.add_argument("--timeout", type=int, default=180, help="login 模式总等待秒数")
    p.add_argument("--qr-ttl", dest="qr_ttl", type=int, default=120, help="二维码有效期（秒）")
    p.add_argument("--qr-refresh", dest="qr_refresh", type=int, default=45,
                   help="二维码重新提取间隔（秒）")
    p.add_argument("--cookie", default="", help="cookie 模式：要写入的 cookie 字符串（name=value; ...）")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    args.headless = str(args.headless).lower() not in ("0", "false", "no", "off")
    if not args.browser_data:
        args.browser_data = os.path.join(os.getcwd(), "browser_data")

    if args.mode == "login":
        if args.platform not in SPECS:
            emit(event="failed", platform=args.platform, error=f"未知平台 {args.platform!r}")
            return 4
        return asyncio.run(do_login(args, args.platform))

    if args.mode == "cookie":
        if args.platform not in SPECS:
            emit(event="failed", platform=args.platform, error=f"未知平台 {args.platform!r}")
            return 4
        return asyncio.run(do_set_cookie(args, args.platform))

    targets = [p for p in PLATFORMS] if args.platforms in ("", "all") \
        else [x.strip() for x in args.platforms.split(",") if x.strip()]
    unknown = [p for p in targets if p not in SPECS]
    if unknown:
        emit(event="failed", error=f"未知平台：{','.join(unknown)}")
        return 4

    async def run_all():
        for p in targets:
            r = await do_check(args, p)
            emit(event="status", **r)

    asyncio.run(run_all())
    emit(event="done", count=len(targets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
