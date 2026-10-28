#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抖音采集执行器（brandsale 自有代码，**不属于** DouYin_Spider 上游）。

职责与 `services/collector-core`（MediaCrawler）平行：当 `BM_DY_DRIVER=spider`
时，collector 的抖音采集 / 登录探活走本脚本驱动 DouYin_Spider（纯 HTTP + 本地签名，
无浏览器），其余六平台仍走 MediaCrawler。

为什么值得引入这条路（真机背景）：
  1. MediaCrawler 的抖音是 Playwright 浏览器自动化，其搜索接口
     `search_info_by_keyword` 已被抖音风控封死 —— 即便登录态真实有效，
     搜索恒返回空 `data`（实测：同一 sessionid，MediaCrawler 搜「波司登」空结果，
     DouYin_Spider 搜「精华」10 条 / 1.8s）；
  2. DouYin_Spider 走签名后的 HTTP 接口（curl_cffi 冒充 Chrome TLS/HTTP2 指纹 +
     a_bogus / msToken 本地签名），不依赖浏览器自动化，出口风控面小得多。

登录态边界（与小红书 Spider_XHS 的**关键差异**）：
  · 小红书能本地出码扫码（纯 HTTP），抖音**不能** —— 抖音登录被滑块 + 设备指纹 +
    confirmed 限频三重风控，任何开源方案都无法自动扫码绕过；
  · 所以本执行器**没有 login 算子**，登录态只能来自「手动导 cookie」：用户在本机
    浏览器登录抖音后，把完整 cookie 通过「填 cookie」接口提交，collector 存成
    session 文件（`--session-file`），采集与探活都从它恢复 `DouyinAuth`。

边界（刻意只做只读，与 spider_xhs_runner 对齐）：
  · 只暴露 search / content_detail / comments / creator 四个算子 + check/probe；
  · **不接**发布 / 私信 / 直播 / 点赞评论等任何写操作；
  · 落盘格式与 MediaCrawler 完全同构（`<dataDir>/douyin/jsonl/{op}_{item_type}_{date}.jsonl`），
    所以 collector 的快照 / 增量读取 / 归一化 / 缓存零改动。

输出约定（与 login_runner.py / spider_xhs_runner.py 一致）：
  · stdout 只吐**单行 JSON 事件**（Node 侧逐行解析）；
  · 人类可读日志走 stderr。

用法：
  spider_dy_runner.py --op probe --spider-dir S
  spider_dy_runner.py --op check --session-file S
  spider_dy_runner.py --op search --keyword 精华 --max-items 50 \
      --data-dir D --session-file S
  spider_dy_runner.py --op content_detail --aweme-id ID --data-dir D --session-file S
  spider_dy_runner.py --op comments --aweme-id ID --max-comments 100 \
      --data-dir D --session-file S
  spider_dy_runner.py --op creator --creator-id <sec_uid> --data-dir D --session-file S
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

DEFAULT_SPIDER_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "services", "douyin-spider")
)


def setup_path(spider_dir: str) -> None:
    """把 DouYin_Spider 目录加进 sys.path（本脚本住在 apps/collector/py，不是它的包内文件）。"""
    if spider_dir not in sys.path:
        sys.path.insert(0, spider_dir)


def log(msg: str) -> None:
    print(f"[spider-dy] {msg}", file=sys.stderr, flush=True)


def emit(**payload: Any) -> None:
    """单行 JSON 事件。Node 侧逐行解析，**绝不能多行**。"""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


# ── 会话持久化 ──────────────────────────────────────────────
# DouYin_Spider 的登录态就是一份完整 Cookie（sessionid / sessionid_ss / ttwid /
# odin_tt / msToken 等）。sessionid 是服务端签发的会话核心，其余签名材料（msToken、
# a_bogus）由 `DouyinAuth` 在内存里可再生。所以只存 cookie 头字符串即可完整恢复
# （`DouyinAuth.open(cookie_str, login_type="cookie")` 是上游文档化路径）。


def save_session(session_file: str, cookie_str: str, source: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(session_file)) or ".", exist_ok=True)
    data = {
        "cookies": cookie_str,
        "loginSource": source,
        "savedAt": datetime.now().isoformat(timespec="seconds"),
    }
    with open(session_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(session_file, 0o600)  # 含 sessionid（会话凭据），收紧权限


def load_session(session_file: str) -> Optional[Dict[str, Any]]:
    try:
        with open(session_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("cookies"):
            return data
    except (OSError, ValueError):
        pass
    return None


def load_auth(session_file: str):
    """从会话文件恢复 DouyinAuth。cookie 失效时（接口探活失败）由调用方翻译成
    「需要重新导 cookie」，这里只在「完全没会话文件」时抛错。"""
    import dy_apis.douyin_api  # noqa: F401  # 先触发加载，破循环导入

    from builder.auth import DouyinAuth

    sess = load_session(session_file)
    if not sess:
        raise RuntimeError("尚未导入抖音 cookie（无会话文件，请在平台绑定页填 cookie）")
    return DouyinAuth.open(sess["cookies"], login_type="cookie")


# ── 探活 / 自检 ──────────────────────────────────────────────


def do_probe(_args) -> int:
    """环境自检：import 全链 + 签名运行时可用（等价于 MediaCrawler 的 run.py --help）。

    注意 import 顺序：DouYin_Spider 上游存在 builder.auth ↔ dy_apis.douyin_api 的
    循环导入，必须先 import dy_apis.douyin_api 触发整包加载，再 from builder.auth
    import DouyinAuth，否则会撞 `partially initialized module`。"""
    import curl_cffi  # noqa: F401

    import dy_apis.douyin_api  # noqa: F401  # 先触发加载，破循环导入

    from builder.auth import DouyinAuth  # noqa: F401
    from dy_apis.douyin_api import DouyinAPI  # noqa: F401

    print(f"DouYin_Spider 就绪（curl_cffi 指纹可用）", flush=True)
    return 0


def do_check(args) -> int:
    """探活：能从会话文件恢复，且真实发一次「我的 uid」接口通过 = bound。

    `get_my_uid` 是登录态强校验（未登录/失效会返回空或被风控拦），比只看
    cookie 里有没有 sessionid 可靠得多。"""
    import dy_apis.douyin_api  # noqa: F401  # 先触发加载，破循环导入

    from dy_apis.douyin_api import DouyinAPI

    sess = load_session(args.session_file)
    if not sess:
        emit(event="status", platform="dy", name="抖音", state="unbound", confidence="verified",
             detail="还没有导入 cookie（无抖音会话文件，请在平台绑定页填 cookie）",
             profileExists=False, cookiePresent=[])
        return 0
    try:
        auth = load_auth(args.session_file)
        uid = DouyinAPI.get_my_uid(auth)
        if not uid:
            raise RuntimeError("get_my_uid 返回空（cookie 已失效）")
    except Exception as e:  # noqa: BLE001
        detail = str(e).splitlines()[0] if str(e) else "恢复失败"
        emit(event="status", platform="dy", name="抖音", state="unbound", confidence="verified",
             detail=f"会话已失效（{detail[:120]}），请重新导入 cookie", profileExists=True,
             cookiePresent=["sessionid"] if "sessionid" in sess["cookies"] else [])
        return 0
    emit(event="status", platform="dy", name="抖音", state="bound", confidence="verified",
         detail=f"接口探活：get_my_uid 正常（uid={uid}，DouYin_Spider 纯 HTTP 通道）",
         profileExists=True, cookiePresent=["sessionid"])
    return 0


def do_set_cookie(args) -> int:
    """导入 cookie：把 `--cookie` 字符串存成 session 文件，并立即探活返回 bound/unbound。

    这是 dy spider 唯一的登录态来源（抖音无法扫码登录）。存盘 + 探活一次完成，
    前端一次调用即可拿到「写进去了没有 / 是不是真的有效」。"""
    import dy_apis.douyin_api  # noqa: F401  # 先触发加载，破循环导入

    from dy_apis.douyin_api import DouyinAPI

    cookie_str = (args.cookie or "").strip()
    if not cookie_str or "=" not in cookie_str:
        emit(event="failed", platform="dy", error="cookie 为空或不是 name=value 形式")
        return 1
    # 先落盘，再探活；探活失败也不删文件 —— 让用户能看清「写进去了但失效」。
    save_session(args.session_file, cookie_str, "manual")
    try:
        from builder.auth import DouyinAuth

        auth = DouyinAuth.open(cookie_str, login_type="cookie")
        uid = DouyinAPI.get_my_uid(auth)
        if not uid:
            raise RuntimeError("get_my_uid 返回空（cookie 已失效）")
    except Exception as e:  # noqa: BLE001
        detail = str(e).splitlines()[0] if str(e) else "探活失败"
        emit(event="status", platform="dy", name="抖音", state="unbound", confidence="verified",
             detail=f"cookie 已写入但探活失败（{detail[:120]}），请重新导入", profileExists=True,
             cookiePresent=["sessionid"] if "sessionid" in cookie_str else [])
        return 0
    emit(event="status", platform="dy", name="抖音", state="bound", confidence="verified",
         detail=f"接口探活：get_my_uid 正常（uid={uid}，DouYin_Spider 纯 HTTP 通道）",
         profileExists=True, cookiePresent=["sessionid"])
    return 0


# ── 采集算子 ────────────────────────────────────────────────


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def append_jsonl(data_dir: str, item_type: str, op_prefix: str, records: List[Dict[str, Any]]) -> str:
    """按 MediaCrawler 约定落盘：`<dataDir>/douyin/jsonl/{op}_{item_type}_{date}.jsonl`。

    注意平台目录名是 `douyin`（不是短码 `dy`）——与 MediaCrawler 的 dataDirName 对齐，
    collector 的 snapshotDataFiles / readRecordsSince 按 `dataDirName` 找目录。"""
    out_dir = os.path.join(data_dir, "douyin", "jsonl")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{op_prefix}_{item_type}_{today()}.jsonl")
    with open(path, "a", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return path


def _author_fields(aweme_info: Dict[str, Any]) -> Dict[str, Any]:
    author = aweme_info.get("author") or {}
    return {
        "nickname": author.get("nickname", ""),
        # collector 派生「作者主页补采」只认 raw.author_user_id（tasks.ts:enqueueAuthorProfiles）。
        # 抖音给的是平台原始 sec_uid —— 喂回 creator 算子必然有效。
        "author_user_id": author.get("sec_uid", "") or str(author.get("uid", "")),
        "sec_uid": author.get("sec_uid", ""),
        "uid": str(author.get("uid", "")),
    }


def _statistics(aweme_info: Dict[str, Any]) -> Dict[str, Any]:
    stats = aweme_info.get("statistics") or {}
    return {
        "digg_count": stats.get("digg_count", ""),
        "comment_count": stats.get("comment_count", ""),
        "collect_count": stats.get("collect_count", ""),
        "share_count": stats.get("share_count", ""),
        "play_count": stats.get("play_count", ""),
    }


def work_row_from_aweme(aweme_info: Dict[str, Any], keyword: str = "") -> Dict[str, Any]:
    """aweme_info → 内容行（字段与 MediaCrawler 抖音落盘口径对齐）。"""
    aweme_id = str(aweme_info.get("aweme_id", ""))
    row: Dict[str, Any] = {
        "aweme_id": aweme_id,
        "type": str(aweme_info.get("aweme_type", "")),
        "desc": aweme_info.get("desc", "") or "",
        "aweme_url": f"https://www.douyin.com/video/{aweme_id}",
        "create_time": aweme_info.get("create_time", 0),  # 秒
        "source_keyword": keyword,
    }
    row.update(_author_fields(aweme_info))
    row.update(_statistics(aweme_info))
    return row


def do_search(args) -> int:
    from dy_apis.douyin_api import DouyinAPI

    keyword = args.keyword
    log(f"搜索：{keyword}（最多 {args.max_items} 条）")
    try:
        works = DouyinAPI.search_some_general_work(args.auth, keyword, args.max_items, "0", "0")
    except Exception as e:  # noqa: BLE001
        print(f"搜索失败：{e}", file=sys.stderr, flush=True)
        return 1
    rows: List[Dict[str, Any]] = []
    for w in works:
        aweme = w.get("aweme_info") or {}
        if not aweme.get("aweme_id"):
            continue
        rows.append(work_row_from_aweme(aweme, keyword))
        if len(rows) >= args.max_items:
            break
    if not rows:
        print("搜索无结果", file=sys.stderr, flush=True)
        return 1
    path = append_jsonl(args.data_dir, "contents", "search", rows)
    log(f"落盘 {len(rows)} 条内容 → {path}")
    return 0


def do_content_detail(args) -> int:
    from dy_apis.douyin_api import DouyinAPI

    url = f"https://www.douyin.com/video/{args.aweme_id}"
    log(f"作品详情：{args.aweme_id}")
    try:
        detail = DouyinAPI.get_work_info(args.auth, url)
    except Exception as e:  # noqa: BLE001
        print(f"详情获取失败：{e}", file=sys.stderr, flush=True)
        return 1
    aweme = (detail or {}).get("aweme_detail") or {}
    if not aweme.get("aweme_id"):
        print("详情响应里没有 aweme_detail", file=sys.stderr, flush=True)
        return 1
    row = work_row_from_aweme(aweme)
    path = append_jsonl(args.data_dir, "contents", "content", [row])
    log(f"落盘 1 条内容 → {path}")
    return 0


def do_comments(args) -> int:
    from dy_apis.douyin_api import DouyinAPI

    url = f"https://www.douyin.com/video/{args.aweme_id}"
    log(f"评论：{args.aweme_id}（最多 {args.max_comments} 条）")
    try:
        comments = DouyinAPI.get_work_all_comment(args.auth, url)
    except Exception as e:  # noqa: BLE001
        print(f"评论获取失败：{e}", file=sys.stderr, flush=True)
        return 1
    rows: List[Dict[str, Any]] = []
    for c in comments[: args.max_comments]:
        user = c.get("user") or {}
        rows.append({
            "comment_id": str(c.get("cid", "")),
            "aweme_id": str(c.get("aweme_id", args.aweme_id)),
            "content": c.get("text", "") or "",
            "nickname": user.get("nickname", ""),
            "author_user_id": user.get("sec_uid", "") or str(user.get("uid", "")),
            "sec_uid": user.get("sec_uid", ""),
            "digg_count": c.get("digg_count", ""),
            "create_time": c.get("create_time", 0),
            "reply_comment_total": c.get("reply_comment_total", ""),
            "ip_label": c.get("ip_label", ""),
        })
    if not rows:
        print("无评论", file=sys.stderr, flush=True)
        return 1
    path = append_jsonl(args.data_dir, "comments", "content", rows)
    log(f"落盘 {len(rows)} 条评论 → {path}")
    return 0


def do_creator(args) -> int:
    from dy_apis.douyin_api import DouyinAPI

    ids = [x.strip() for x in args.creator_ids.split(",") if x.strip()]
    if not ids:
        print("creator_ids 为空", file=sys.stderr, flush=True)
        return 1
    rows: List[Dict[str, Any]] = []
    for uid in ids:
        log(f"用户资料：{uid}")
        # get_user_info 需要完整 user_url（内部取 URL 末段做 sec_user_id）
        url = f"https://www.douyin.com/user/{uid}"
        try:
            res = DouyinAPI.get_user_info(args.auth, url)
        except Exception as e:  # noqa: BLE001
            log(f"用户 {uid} 获取异常（跳过）：{e}")
            continue
        user = (res or {}).get("user") or {}
        if not user:
            log(f"用户 {uid} 响应缺 user（跳过）")
            continue
        rows.append({
            "author_user_id": uid,
            "sec_uid": user.get("sec_uid", uid),
            "uid": str(user.get("uid", "")),
            "nickname": user.get("nickname", ""),
            "signature": user.get("signature", ""),
            "follower_count": user.get("follower_count", ""),
            "following_count": user.get("following_count", ""),
            "aweme_count": user.get("aweme_count", ""),
            "total_favorited": user.get("total_favorited", ""),
            "ip_location": user.get("ip_location", ""),
            "home_url": f"https://www.douyin.com/user/{uid}",
        })
    if not rows:
        print("画像无结果", file=sys.stderr, flush=True)
        return 1
    path = append_jsonl(args.data_dir, "creators", "creator", rows)
    log(f"落盘 {len(rows)} 条资料 → {path}")
    return 0


def parse_args(argv: Optional[List[str]] = None):
    p = argparse.ArgumentParser(description="brandsale 抖音采集执行器（DouYin_Spider 后端）")
    p.add_argument("--op", required=True,
                   choices=("probe", "check", "set_cookie", "search", "content_detail", "comments", "creator"))
    p.add_argument("--spider-dir", default=DEFAULT_SPIDER_DIR)
    p.add_argument("--session-file", default="")
    p.add_argument("--data-dir", default="")
    p.add_argument("--keyword", default="")
    p.add_argument("--aweme-id", default="")
    p.add_argument("--creator-ids", default="")
    p.add_argument("--cookie", default="")
    p.add_argument("--max-items", type=int, default=50)
    p.add_argument("--max-comments", type=int, default=100)
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    setup_path(args.spider_dir)

    if args.op == "probe":
        return do_probe(args)
    if args.op == "check":
        return do_check(args)
    if args.op == "set_cookie":
        return do_set_cookie(args)

    # 采集算子：恢复会话 → 执行
    if not args.session_file:
        print("缺少 --session-file", file=sys.stderr, flush=True)
        return 4
    if args.op == "search" and not args.keyword:
        print("search 需要 --keyword", file=sys.stderr, flush=True)
        return 4
    if args.op in ("content_detail", "comments") and not args.aweme_id:
        print(f"{args.op} 需要 --aweme-id", file=sys.stderr, flush=True)
        return 4
    if args.op == "creator" and not args.creator_ids:
        print("creator 需要 --creator-ids", file=sys.stderr, flush=True)
        return 4

    try:
        args.auth = load_auth(args.session_file)
    except Exception as e:  # noqa: BLE001
        print(f"登录态不可用：{e}", file=sys.stderr, flush=True)
        return 5

    if args.op == "search":
        return do_search(args)
    if args.op == "content_detail":
        return do_content_detail(args)
    if args.op == "comments":
        return do_comments(args)
    if args.op == "creator":
        return do_creator(args)
    print(f"未知算子：{args.op}", file=sys.stderr, flush=True)
    return 4


if __name__ == "__main__":
    sys.exit(main())
