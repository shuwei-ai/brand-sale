#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""brandsale 内嵌采集内核 · 薄入口。

本文件是 MediaCrawler 采集内核在 brandsale 仓库内的**唯一**驱动入口。它替换了
上游的 `main.py` + `cmd_arg/`（Typer CLI）两层，理由：
  · brandsale 需要一个"被程序调用"的入口，不需要交互式 CLI；
  · 上游 main.py 依赖 database/ 与 excel 落盘，而本仓库已把这两块裁掉
    （store/ 只保留 json/jsonl）。

调用方是 `apps/collector`（Node sidecar）：它用 `python run.py ...` 起一个采集子进程，
等它退出后读取落盘的 jsonl。参数到 config 模块常量的映射**照抄上游 cmd_arg/arg.py**，
以保证行为与 MediaCrawler 原生 CLI 一致 —— 尤其是 detail/creator 模式靠**平台专属 ID 列表**
驱动这一点，变量名写错就会出现"参数传了但采集器读不到"。

用法：
    python run.py --platform xhs --type search --keywords 护肤 --max-notes 20
    python run.py --platform dy  --type detail --specified-id 7xxxxxxxxx --get-comments true
    python run.py --platform bili --type creator --creator-id 12345
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
import re
import sys
import traceback
from typing import Optional, Type

# 子进程可能从任意 cwd 启动，把本目录塞进 sys.path，保证 `import config` 等可用
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# 中文日志在非 UTF-8 终端下会抛 UnicodeEncodeError，强制 stdout/stderr 走 UTF-8
if sys.stdout and hasattr(sys.stdout, "buffer") and (sys.stdout.encoding or "").lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "buffer") and (sys.stderr.encoding or "").lower() != "utf-8":
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import config  # noqa: E402
from base.base_crawler import AbstractCrawler  # noqa: E402
from media_platform.bilibili import BilibiliCrawler  # noqa: E402
from media_platform.douyin import DouYinCrawler  # noqa: E402
from media_platform.kuaishou import KuaishouCrawler  # noqa: E402
from media_platform.tieba import TieBaCrawler  # noqa: E402
from media_platform.weibo import WeiboCrawler  # noqa: E402
from media_platform.xhs import XiaoHongShuCrawler  # noqa: E402
from media_platform.zhihu import ZhihuCrawler  # noqa: E402

PLATFORMS = ("xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu")
CRAWLER_TYPES = ("search", "detail", "creator")
LOGIN_TYPES = ("qrcode", "phone", "cookie")
CDP_MODES = ("auto", "true", "false", "reuse")

# detail 模式：CLI 的 --specified-id 落到哪个 config 列表
SPECIFIED_LIST_ATTR = {
    "xhs": "XHS_SPECIFIED_NOTE_URL_LIST",
    "bili": "BILI_SPECIFIED_ID_LIST",
    "dy": "DY_SPECIFIED_ID_LIST",
    "wb": "WEIBO_SPECIFIED_ID_LIST",
    "ks": "KS_SPECIFIED_ID_LIST",
    "zhihu": "ZHIHU_SPECIFIED_ID_LIST",
}
# creator 模式：CLI 的 --creator-id 落到哪个 config 列表
CREATOR_LIST_ATTR = {
    "xhs": "XHS_CREATOR_ID_LIST",
    "bili": "BILI_CREATOR_ID_LIST",
    "dy": "DY_CREATOR_ID_LIST",
    "wb": "WEIBO_CREATOR_ID_LIST",
    "ks": "KS_CREATOR_ID_LIST",
    "zhihu": "ZHIHU_CREATOR_URL_LIST",
}


class CrawlerFactory:
    """与上游 main.py 一致：平台短码 → 采集器类。"""

    CRAWLERS: dict[str, Type[AbstractCrawler]] = {
        "xhs": XiaoHongShuCrawler,
        "dy": DouYinCrawler,
        "ks": KuaishouCrawler,
        "bili": BilibiliCrawler,
        "wb": WeiboCrawler,
        "tieba": TieBaCrawler,
        "zhihu": ZhihuCrawler,
    }

    @staticmethod
    def create_crawler(platform: str) -> AbstractCrawler:
        cls = CrawlerFactory.CRAWLERS.get(platform)
        if not cls:
            raise ValueError(f"不支持的平台 {platform!r}，可选：{', '.join(sorted(CrawlerFactory.CRAWLERS))}")
        return cls()


def _bool(v: object) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "t", "yes", "y", "on")


def _detect_local_browser() -> Optional[str]:
    """找本机已安装的 Chrome/Edge 可执行文件；找不到返回 None。

    只用于 `--cdp auto`。探测失败一律降级为 playwright 自带 chromium，
    绝不让"探测"本身成为采集失败的原因。
    """
    try:
        from tools.browser_launcher import BrowserLauncher

        paths = BrowserLauncher().detect_browser_paths()
    except Exception:  # noqa: BLE001 - 探测是旁路能力，任何异常都降级
        return None
    return paths[0] if paths else None


def _resolve_cdp(mode: str) -> tuple[bool, str]:
    """把 --cdp 的四态解析成 (是否用 CDP, 说明文案)。"""
    if mode == "reuse":
        return True, "reuse(常驻复用)"
    if mode == "true":
        return True, "forced(cdp)"
    if mode == "false":
        return False, "forced(chromium)"
    found = _detect_local_browser()
    if found:
        return True, f"auto->cdp({found})"
    return False, "auto->chromium(未装 Chrome/Edge)"


def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="brandsale 内嵌采集内核入口（MediaCrawler 内核）")
    p.add_argument("--platform", required=True, choices=PLATFORMS)
    p.add_argument("--type", dest="crawler_type", default="search", choices=CRAWLER_TYPES)
    p.add_argument("--login-type", dest="login_type", default="qrcode", choices=LOGIN_TYPES)
    p.add_argument("--keywords", default="")
    p.add_argument("--specified-id", dest="specified_id", default="", help="detail 模式的 ID/URL 列表，逗号分隔")
    p.add_argument("--creator-id", dest="creator_id", default="", help="creator 模式的创作者 ID/URL 列表，逗号分隔")
    p.add_argument("--max-notes", dest="max_notes", type=int, default=config.CRAWLER_MAX_NOTES_COUNT)
    p.add_argument(
        "--max-comments", dest="max_comments", type=int, default=config.CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES
    )
    p.add_argument("--get-comments", dest="get_comments", default="true")
    p.add_argument("--get-sub-comments", dest="get_sub_comments", default="false")
    p.add_argument("--headless", default="false")
    p.add_argument("--start-page", dest="start_page", type=int, default=1)
    p.add_argument("--save-path", dest="save_path", default="", help="落盘根目录（绝对路径优先），留空则用 ./data")
    p.add_argument("--cookies", default="")
    p.add_argument(
        "--cdp",
        default="auto",
        choices=CDP_MODES,
        help="浏览器启动模式：reuse=常驻复用（端口上有常驻浏览器就直接接上、没有才拉起且**退出不关**，"
        "由 collector 按平台下发的 --cdp-port 定位与回收）；"
        "auto=本机有 Chrome/Edge 就用它（免下载 chromium），否则用 playwright 自带 chromium；"
        "true=强制 CDP；false=强制 playwright chromium",
    )
    p.add_argument(
        "--cdp-port",
        dest="cdp_port",
        type=int,
        default=config.CDP_DEBUG_PORT,
        help="浏览器调试端口。reuse 模式下必须由调用方固定下发（每个平台一个），"
        "因为 collector 回收常驻浏览器时就是靠这个端口找到它",
    )
    p.add_argument(
        "--profile-only",
        dest="profile_only",
        default="",
        help="creator 模式只取个人主页资料（粉丝数等），不继续抓该作者的作品；默认读 BM_MC_PROFILE_ONLY",
    )
    p.add_argument("--start-day", dest="start_day", default="")
    p.add_argument("--end-day", dest="end_day", default="")
    return p.parse_args()


def _split_ids(raw: str) -> list[str]:
    return [x.strip() for x in raw.split(",") if x.strip()]


def _normalize_tieba_note_id(value: str) -> str:
    """贴吧的 --specified-id 允许传 /p/<id> 形式的帖子 URL。"""
    m = re.search(r"/p/(\d+)", value)
    return m.group(1) if m else value


def _normalize_tieba_creator_url(value: str) -> str:
    if value.startswith(("http://", "https://")):
        return value
    return f"https://tieba.baidu.com/home/main?id={value}"


def _normalize_weibo_note_id(value: str) -> str:
    """微博的 --specified-id 只吃 note_id。

    但产品内归一化输出的 `url` 就是 `https://m.weibo.cn/detail/<note_id>`，而详情接口
    是拿 id 去拼 `{host}/detail/{id}` —— 把整个 URL 传进来会拼成
    `.../detail/https://m.weibo.cn/detail/<id>`，微博直接回 404 页面，结果是
    **子进程退出码 0 + 0 条记录**（真机踩过）。这里容错地把 URL 收敛回 id，
    让"搜索结果里的 url 能不能喂回详情"这个闭环成立。
    """
    m = re.search(r"/detail/(\d+)", value) or re.search(r"/status(?:es)?/(\d+)", value)
    if m:
        return m.group(1)
    if value.startswith(("http://", "https://")):
        # 桌面端形态 https://weibo.com/<uid>/<mid>：mid 是最后一段纯数字
        for seg in reversed([s for s in re.split(r"[/?#]", value) if s]):
            if seg.isdigit():
                return seg
    return value


def _apply(args: argparse.Namespace) -> str:
    """把 CLI 参数写回 config 模块级常量（等价于上游 cmd_arg/arg.py 的 override 段）。

    返回一句话说明浏览器启动模式，供日志打印。
    """
    config.PLATFORM = args.platform
    config.LOGIN_TYPE = args.login_type
    config.CRAWLER_TYPE = args.crawler_type
    config.START_PAGE = args.start_page
    config.KEYWORDS = args.keywords
    config.ENABLE_GET_COMMENTS = _bool(args.get_comments)
    config.ENABLE_GET_SUB_COMMENTS = _bool(args.get_sub_comments)
    # 固定项：brandsale 只要结构化内容，不要媒体文件与词云。
    config.ENABLE_GET_MEDIA = False
    config.ENABLE_GET_WORDCLOUD = False
    config.HEADLESS = _bool(args.headless)
    config.CDP_HEADLESS = _bool(args.headless)
    # 浏览器启动：默认 auto —— 本机有 Chrome/Edge 就走 CDP（隔离 profile，不碰用户日常浏览器，
    # 也省掉 150MB chromium 下载）；没有就退回 playwright 自带 chromium。
    cdp_enabled, mode_note = _resolve_cdp(args.cdp)
    config.ENABLE_CDP_MODE = cdp_enabled
    config.CDP_DEBUG_PORT = args.cdp_port
    # 上游默认 CDP_CONNECT_EXISTING=True，要求用户手工去 chrome://inspect 开远程调试，
    # 对"被程序调用"的场景不可用；这里改成自己拉起一个独立浏览器的隔离 profile。
    config.CDP_CONNECT_EXISTING = False
    # 常驻复用（brandsale 扩展）：端口上有就用、没有才拉起，且退出时**不杀**。
    # 两个开关一起置真 —— CDP_PERSISTENT 决定走哪条启动分支，
    # CDP_CONNECT_EXISTING 决定 cleanup() 跳过「杀进程」（语义正是"这个浏览器不归本进程"）。
    config.CDP_PERSISTENT = args.cdp == "reuse"
    if config.CDP_PERSISTENT:
        config.CDP_CONNECT_EXISTING = True
    config.SAVE_DATA_OPTION = "jsonl"
    config.COOKIES = args.cookies
    config.SAVE_DATA_PATH = args.save_path
    config.CRAWLER_MAX_NOTES_COUNT = args.max_notes
    config.CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES = args.max_comments
    # 「只要主页资料」：CLI 显式给了就用它，否则读环境变量（collector 用 env 传，见 core-runner.ts）
    profile_only = args.profile_only if args.profile_only != "" else os.environ.get("BM_MC_PROFILE_ONLY", "")
    config.PROFILE_ONLY = _bool(profile_only)
    if args.start_day:
        config.START_DAY = args.start_day
    if args.end_day:
        config.END_DAY = args.end_day

    # detail / creator 模式靠**平台专属 ID 列表**驱动，不是 keywords。
    ids = _split_ids(args.specified_id)
    if ids:
        if args.platform == "tieba":
            config.TIEBA_SPECIFIED_ID_LIST = [_normalize_tieba_note_id(x) for x in ids]
        elif args.platform == "wb":
            config.WEIBO_SPECIFIED_ID_LIST = [_normalize_weibo_note_id(x) for x in ids]
        elif args.platform in SPECIFIED_LIST_ATTR:
            setattr(config, SPECIFIED_LIST_ATTR[args.platform], ids)

    creators = _split_ids(args.creator_id)
    if creators:
        if args.platform == "tieba":
            config.TIEBA_CREATOR_URL_LIST = [_normalize_tieba_creator_url(x) for x in creators]
        elif args.platform in CREATOR_LIST_ATTR:
            setattr(config, CREATOR_LIST_ATTR[args.platform], creators)

    return mode_note


async def _close_crawler(crawler: AbstractCrawler) -> None:
    """收尾：关掉浏览器会话。

    七个平台都实现了 `close()`，但这里以前**只调 `start()`** —— 于是
    `CDPBrowserManager.cleanup()` 那条优雅关闭路径成了死代码，浏览器只能靠
    `atexit` / 信号处理器兜底。而 collector 超时是「先 SIGTERM、5 秒后 SIGKILL」
    （`apps/collector/src/core-runner.ts`），**SIGKILL 不跑 atexit** → 被强杀的那次
    会留下一个孤儿 Chrome 窗口。

    收尾失败不能影响退出码：采集结果此时已经落盘，关不上只记一行日志。
    """
    close = getattr(crawler, "close", None)
    if not callable(close):
        return
    try:
        await close()
    except Exception as exc:  # noqa: BLE001 - 收尾异常不该盖掉真实退出码
        print(f"[collector-core] 关闭浏览器会话失败（已忽略）：{exc}", file=sys.stderr, flush=True)


async def _run(args: argparse.Namespace) -> None:
    mode_note = _apply(args)
    print(
        f"[collector-core] platform={config.PLATFORM} type={config.CRAWLER_TYPE} "
        f"login={config.LOGIN_TYPE} headless={config.HEADLESS} browser={mode_note} "
        f"comments={config.ENABLE_GET_COMMENTS} max_notes={config.CRAWLER_MAX_NOTES_COUNT} "
        f"save_path={config.SAVE_DATA_PATH or 'data/'}",
        flush=True,
    )
    crawler = CrawlerFactory.create_crawler(config.PLATFORM)
    try:
        await crawler.start()
    finally:
        await _close_crawler(crawler)


def main() -> int:
    try:
        args = _parse()
    except SystemExit:
        raise
    try:
        asyncio.run(_run(args))
        print("[collector-core] 采集结束", flush=True)
        return 0
    except KeyboardInterrupt:
        print("[collector-core] 收到中断信号，退出", flush=True)
        return 130
    except Exception as exc:  # noqa: BLE001 - 顶层兜底，把栈打到 stderr 供 collector 记日志
        traceback.print_exc()
        print(f"[collector-core] 采集失败：{exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
