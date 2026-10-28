#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Spider_XHS 采集执行器（brandsale 自有代码，**不属于** Spider_XHS 上游）。

职责与 `services/collector-core`（MediaCrawler）平行：当 `BM_XHS_DRIVER=spider`
时，collector 的小红书采集 / 登录 / 探活走本脚本驱动 `services/spider-xhs`
（纯 HTTP + 本地签名，无浏览器），其余六平台仍走 MediaCrawler。

为什么值得引入这条路（真机背景）：
  1. MediaCrawler 的小红书是 Playwright 浏览器自动化 —— 出口 IP 被风控时
     （error_code 300012）连二维码接口都不让调，且无头指纹易被判机器人；
  2. Spider_XHS 走签名后的 HTTP 接口，扫码登录也只在本机出码（无浏览器），
     签名全部本地算（PyExecJS + Node + crypto-js）。

边界（刻意只做只读）：
  · 只暴露 search / content_detail / comments / creator 四个算子 + login/check/probe；
  · **不接**蒲公英 / 千帆 / 私信 / 直播 / 发布 / 点赞评论等任何写操作或已移除数据源；
  · 落盘格式与 MediaCrawler 完全同构（`<dataDir>/xhs/jsonl/{op}_{item_type}_{date}.jsonl`），
    所以 collector 的快照 / 增量读取 / 归一化 / 缓存零改动。

输出约定（与 login_runner.py 一致）：
  · stdout 只吐**单行 JSON 事件**（Node 侧逐行解析）；
  · 人类可读日志走 stderr。

用法：
  spider_xhs_runner.py --op probe
  spider_xhs_runner.py --op login --timeout 180 --qr-ttl 120 --session-file S
  spider_xhs_runner.py --op check --session-file S
  spider_xhs_runner.py --op search --keyword 精华 --max-items 50 \
      --data-dir D --session-file S
  spider_xhs_runner.py --op content_detail --note-id ID --data-dir D --session-file S
  spider_xhs_runner.py --op comments --note-id ID --max-comments 100 \
      --sub-comments false --data-dir D --session-file S
  spider_xhs_runner.py --op creator --creator-ids a,b,c --data-dir D --session-file S
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

DEFAULT_SPIDER_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "services", "spider-xhs")
)


def setup_path(spider_dir: str) -> None:
    """把 Spider_XHS 目录加进 sys.path（本脚本住在 apps/collector/py，不是它的包内文件）。"""
    if spider_dir not in sys.path:
        sys.path.insert(0, spider_dir)


def log(msg: str) -> None:
    print(f"[spider-xhs] {msg}", file=sys.stderr, flush=True)


def emit(**payload: Any) -> None:
    """单行 JSON 事件。Node 侧逐行解析，**绝不能多行**。"""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


# ── 会话持久化 ──────────────────────────────────────────────
# Spider_XHS 的登录态就是一份完整 Cookie（a1 + 服务端签发的 web_session 等），
# b1 / 签名材料全部本地可再生（见 xhs_utils/xhs_pc/auth.py 的类注释），
# 所以只存 cookie 头字符串即可完整恢复（XHSPcAuth.from_cookie 是上游文档化路径）。


def save_session(session_file: str, cookies: str, user_id: str, source: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(session_file)) or ".", exist_ok=True)
    data = {
        "cookies": cookies,
        "userId": user_id,
        "loginSource": source,
        "savedAt": datetime.now().isoformat(timespec="seconds"),
    }
    with open(session_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(session_file, 0o600)  # 含 web_session（会话凭据），收紧权限


def load_session(session_file: str) -> Optional[Dict[str, Any]]:
    try:
        with open(session_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) and data.get("cookies") else None
    except (OSError, ValueError):
        return None


def load_auth(session_file: str):
    """从会话文件恢复 XHSPcAuth；from_cookie 内部会 bootstrap（user/me），
    cookie 失效时直接抛错 —— 调用方把它翻译成「需要重新登录」。"""
    from xhs_utils.xhs_pc import XHSPcAuth

    sess = load_session(session_file)
    if not sess:
        raise RuntimeError("尚未登录小红书（无会话文件，请先在平台绑定页扫码）")
    auth = XHSPcAuth.from_cookie(sess["cookies"])
    save_session(session_file, auth.cookies, auth.user_id, "restored")
    return auth


# ── 登录（纯 HTTP 扫码，无浏览器） ───────────────────────────


def qr_data_url(url: str) -> str:
    """把登录二维码渲染成 data URL（SVG，零图片库依赖）。

    用 SVG 而不是 PNG：`qrcode` 的 PNG 出图需要 PIL/pypng，上游 requirements
    都没带；SVG 工厂只依赖标准库 xml.etree，前端 <img> 直接可渲染。
    """
    import qrcode
    import qrcode.image.svg

    qr = qrcode.QRCode(box_size=16, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def do_login(args) -> int:
    from apis.xhs_pc_apis import XHS_Apis
    from apis.xhs_pc_login_apis import XHSLoginApi
    from xhs_utils.xhs_core.auth import PC_PLATFORM_CONFIG
    from xhs_utils.xhs_pc import XHSPcAuth
    from xhs_utils.xhs_pc.auth import _AUTH_FACTORY_TOKEN

    login = XHSLoginApi()
    log("初始化匿名设备（本地生成 a1 / 引导 cookie）…")
    try:
        cookies = login.generate_init_cookies()
    except Exception as e:  # noqa: BLE001
        emit(event="failed", platform="xhs", error=f"匿名设备初始化失败：{e}")
        return 1

    deadline = time.monotonic() + args.timeout
    qr: Optional[Dict[str, Any]] = None
    while time.monotonic() < deadline:
        if qr is None:
            try:
                success, msg, qr_data = login.generate_qrcode(cookies)
            except Exception as e:  # noqa: BLE001
                emit(event="failed", platform="xhs", error=f"获取二维码失败：{e}")
                return 1
            if not success:
                # 小红书侧风控（含 IP 风控）在这一步最常见地暴露出来
                emit(event="failed", platform="xhs", error=f"获取二维码失败：{msg}")
                return 1
            cookies = qr_data["cookies"]

            # 复刻上游 qrcode_login 第 3 步：出码后先做一次预检查 + webprofile，
            # 保证签名环境与真机一致（跳过会吃风控）。
            try:
                success, msg, cookies = login.check_qrcode_status(qr_data["qr_id"], qr_data["code"], cookies)
                if success:
                    emit(event="failed", platform="xhs", error="二维码在展示前已被确认，拒绝复用异常登录状态")
                    return 1
                if msg == "请扫描二维码":
                    login.ensure_webprofile(cookies)
                elif msg != "请确认登录":
                    emit(event="failed", platform="xhs", error=f"二维码预检查状态异常：{msg}")
                    return 1
            except Exception as e:  # noqa: BLE001
                emit(event="failed", platform="xhs", error=f"匿名指纹验收失败：{e}")
                return 1

            emit(event="qr", platform="xhs", dataUrl=qr_data_url(qr_data["qr_url"]),
                 expiresIn=args.qr_ttl, at=int(time.time() * 1000))
            qr = qr_data
            log("二维码已就绪（SVG），等待扫码…")

        try:
            success, msg, cookies = login.check_qrcode_status(qr["qr_id"], qr["code"], cookies)
        except Exception as e:  # noqa: BLE001
            log(f"二维码状态检查失败（继续重试）：{e}")
            time.sleep(2.0)
            continue

        if success:
            log("扫码确认成功，构建会话…")
            auth = XHSPcAuth(
                cookies=cookies,
                login_source="qrcode",
                host_cookies=login.host_cookies_snapshot(),
                host_cookie_state=login.host_cookie_state(),
                cookie_source_url=PC_PLATFORM_CONFIG.origin("api"),
                profile=login.profile,
                _factory_token=_AUTH_FACTORY_TOKEN,
            )
            XHS_Apis(auth).bootstrap()
            save_session(args.session_file, auth.cookies, auth.user_id, "qrcode")
            emit(event="logged_in", platform="xhs",
                 seconds=round(args.timeout - (deadline - time.monotonic()), 1))
            return 0
        if msg == "二维码已过期":
            log("二维码过期，重新生成…")
            qr = None
            continue
        time.sleep(2.0)

    emit(event="timeout", platform="xhs", seconds=args.timeout)
    return 2


def do_check(args) -> int:
    """探活：能从会话文件恢复且 user/me 通过 = bound。"""
    from xhs_utils.xhs_pc import XHSPcAuth

    sess = load_session(args.session_file)
    if not sess:
        emit(event="status", platform="xhs", name="小红书", state="unbound", confidence="verified",
             detail="还没有登录过（无 Spider_XHS 会话文件）", profileExists=False, cookiePresent=[])
        return 0
    try:
        auth = XHSPcAuth.from_cookie(sess["cookies"])
    except Exception as e:  # noqa: BLE001
        detail = str(e).splitlines()[0] if str(e) else "恢复失败"
        emit(event="status", platform="xhs", name="小红书", state="unbound", confidence="verified",
             detail=f"会话已失效（{detail[:120]}），请重新扫码", profileExists=True,
             cookiePresent=["web_session"] if "web_session" in sess["cookies"] else [])
        return 0
    # from_cookie 内部已 bootstrap 成功（user/me 拿到 user_id）→ 接口级验证通过
    emit(event="status", platform="xhs", name="小红书", state="bound", confidence="verified",
         detail="接口探活：user/me 正常（Spider_XHS 纯 HTTP 通道）", profileExists=True,
         cookiePresent=["web_session"])
    return 0


# ── 采集算子 ────────────────────────────────────────────────


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def append_jsonl(data_dir: str, item_type: str, op_prefix: str, records: List[Dict[str, Any]]) -> str:
    """按 MediaCrawler 约定落盘：`<dataDir>/xhs/jsonl/{op}_{item_type}_{date}.jsonl`。"""
    out_dir = os.path.join(data_dir, "xhs", "jsonl")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{op_prefix}_{item_type}_{today()}.jsonl")
    with open(path, "a", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return path


def _interact(note_card: Dict[str, Any]) -> Dict[str, Any]:
    inter = note_card.get("interact_info") or {}
    return {
        "liked_count": inter.get("liked_count", ""),
        "collected_count": inter.get("collected_count", ""),
        "comment_count": inter.get("comment_count", ""),
        "share_count": inter.get("share_count", ""),
    }


def _user_fields(note_card: Dict[str, Any]) -> Dict[str, Any]:
    user = note_card.get("user") or {}
    return {
        "nickname": user.get("nickname", ""),
        "user_id": user.get("user_id", ""),
        # author_user_id 是 collector 派生「作者主页补采」的唯一入参
        # （tasks.ts:enqueueAuthorProfiles 只认 raw.author_user_id）。
        # Spider_XHS 给的是平台原始 UID —— 比 MediaCrawler 的脱敏 hash 可靠，
        # 喂回 creator 算子必然有效。
        "author_user_id": user.get("user_id", ""),
    }


def note_row_from_search(item: Dict[str, Any], keyword: str) -> Dict[str, Any]:
    note_id = str(item.get("id", ""))
    token = str(item.get("xsec_token", ""))
    nc = item.get("note_card") or {}
    row: Dict[str, Any] = {
        "note_id": note_id,
        "type": nc.get("type", ""),
        "title": nc.get("display_title", "") or "",
        "desc": "",
        "note_url": f"https://www.xiaohongshu.com/explore/{note_id}?xsec_token={token}&xsec_source=pc_search",
        "xsec_token": token,
        "source_keyword": keyword,
        "time": nc.get("time") or 0,
    }
    row.update(_user_fields(nc))
    row.update(_interact(nc))
    return row


def note_row_from_detail(item: Dict[str, Any]) -> Dict[str, Any]:
    """feed 接口的 items[0] → 内容行（含 desc / time / 完整互动数）。"""
    nc = item.get("note_card") or {}
    note_id = str(item.get("id", ""))
    row: Dict[str, Any] = {
        "note_id": note_id,
        "type": nc.get("type", ""),
        "title": nc.get("title", "") or "",
        "desc": nc.get("desc", "") or "",
        "note_url": item.get("url", ""),
        "xsec_token": "",
        "time": nc.get("time") or 0,
        "tag_list": [t.get("name", "") for t in (nc.get("tag_list") or []) if isinstance(t, dict)],
    }
    row.update(_user_fields(nc))
    row.update(_interact(nc))
    return row


def find_xsec_token(data_dir: str, note_id: str) -> str:
    """在本地已采的 contents jsonl 里找该笔记的 xsec_token（详情/评论接口需要它）。

    搜索结果落盘时把 token 存在行上 —— 一次本地扫描就能闭环「搜索→详情」，
    不需要为拿 token 再打一次平台接口。
    """
    root = os.path.join(data_dir, "xhs", "jsonl")
    if not os.path.isdir(root):
        return ""
    for name in sorted(os.listdir(root), reverse=True):
        if "contents" not in name or not name.endswith(".jsonl"):
            continue
        try:
            with open(os.path.join(root, name), "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if str(rec.get("note_id")) == note_id and rec.get("xsec_token"):
                        return str(rec["xsec_token"])
        except OSError:
            continue
    return ""


def note_url_of(data_dir: str, note_id: str) -> str:
    token = find_xsec_token(data_dir, note_id)
    if token:
        return f"https://www.xiaohongshu.com/explore/{note_id}?xsec_token={token}&xsec_source=pc_search"
    # 没有本地 token（模型直接给了个 id）：裸拼仍可尝试，部分笔记在 pc_feed 口径下可用
    return f"https://www.xiaohongshu.com/explore/{note_id}"


def do_search(args, apis) -> int:
    keyword = args.keyword
    log(f"搜索：{keyword}（最多 {args.max_items} 条）")
    success, msg, notes = apis.search_some_note(keyword, args.max_items)
    if not success:
        print(f"搜索失败：{msg}", file=sys.stderr, flush=True)
        return 1
    rows: List[Dict[str, Any]] = []
    for item in notes:
        if str(item.get("model_type")) != "note":
            continue  # 搜索结果里混有广告/用户卡片段落
        row = note_row_from_search(item, keyword)
        # 补一次详情拿正文与发布时间（与 MediaCrawler 的搜索行为对齐：
        # 它的 search_contents 落盘就带 desc）。失败不致命，保留搜索级字段。
        try:
            ok, _m, detail = apis.get_note_info(row["note_url"])
            if ok and detail:
                item0 = ((detail.get("data") or {}).get("items") or [{}])[0]
                if item0:
                    full = note_row_from_detail({**item0, "url": row["note_url"]})
                    full["source_keyword"] = keyword
                    full["xsec_token"] = row["xsec_token"]
                    row = full
        except Exception as e:  # noqa: BLE001
            log(f"详情补齐失败（保留搜索级字段）：{e}")
        rows.append(row)
        if len(rows) >= args.max_items:
            break
    path = append_jsonl(args.data_dir, "contents", "search", rows)
    log(f"落盘 {len(rows)} 条内容 → {path}")
    return 0 if rows else 1


def do_content_detail(args, apis) -> int:
    url = note_url_of(args.data_dir, args.note_id)
    log(f"笔记详情：{args.note_id}")
    success, msg, detail = apis.get_note_info(url)
    if not success or not detail:
        print(f"详情获取失败：{msg}", file=sys.stderr, flush=True)
        return 1
    item0 = ((detail.get("data") or {}).get("items") or [{}])[0]
    if not item0:
        print("详情响应里没有 items", file=sys.stderr, flush=True)
        return 1
    row = note_row_from_detail({**item0, "url": url})
    path = append_jsonl(args.data_dir, "contents", "content", [row])
    log(f"落盘 1 条内容 → {path}")
    return 0


def do_comments(args, apis) -> int:
    url = note_url_of(args.data_dir, args.note_id)
    log(f"评论：{args.note_id}（最多 {args.max_comments} 条，二级={args.sub_comments}）")
    success, msg, comments = apis.get_note_all_out_comment(args.note_id, _token_of(url), None)
    if not success:
        print(f"评论获取失败：{msg}", file=sys.stderr, flush=True)
        return 1
    rows: List[Dict[str, Any]] = []
    for c in comments[: args.max_comments]:
        user = c.get("user_info") or {}
        rows.append({
            "comment_id": str(c.get("id", "")),
            "note_id": str(c.get("note_id", args.note_id)),
            "content": c.get("content", ""),
            "nickname": user.get("nickname", ""),
            "user_id": user.get("user_id", ""),
            "author_user_id": user.get("user_id", ""),
            "like_count": c.get("like_count", ""),
            "create_time": c.get("create_time", 0),  # 毫秒
            "sub_comment_count": c.get("sub_comment_count", ""),
            "ip_location": c.get("ip_location", ""),
        })
        # 二级评论默认关（与 MediaCrawler 的 --get-sub-comments false 对齐），
        # 只有显式要求时才逐条拉 —— 每条都是一次独立接口调用，代价不成比例。
        if args.sub_comments and len(rows) < args.max_comments:
            try:
                ok, _m, enriched = apis.get_note_all_inner_comment(c, _token_of(url), None)
                if ok:
                    for sub in enriched.get("sub_comments", []):
                        suser = sub.get("user_info") or {}
                        rows.append({
                            "comment_id": str(sub.get("id", "")),
                            "note_id": str(sub.get("note_id", args.note_id)),
                            "content": sub.get("content", ""),
                            "nickname": suser.get("nickname", ""),
                            "user_id": suser.get("user_id", ""),
                            "author_user_id": suser.get("user_id", ""),
                            "like_count": sub.get("like_count", ""),
                            "create_time": sub.get("create_time", 0),
                            "sub_comment_count": "",
                            "ip_location": sub.get("ip_location", ""),
                            "parent_comment_id": str(c.get("id", "")),
                        })
            except Exception as e:  # noqa: BLE001
                log(f"二级评论失败（跳过）：{e}")
    rows = rows[: args.max_comments]
    path = append_jsonl(args.data_dir, "comments", "content", rows)
    log(f"落盘 {len(rows)} 条评论 → {path}")
    return 0 if rows else 1


def _token_of(url: str) -> str:
    m = re.search(r"[?&]xsec_token=([^&]+)", url)
    return m.group(1) if m else ""


def do_creator(args, apis) -> int:
    """个人主页资料（profile-only：与 collector 的补采语义一致，不抓作品）。"""
    ids = [x.strip() for x in args.creator_ids.split(",") if x.strip()]
    if not ids:
        print("creator_ids 为空", file=sys.stderr, flush=True)
        return 1
    rows: List[Dict[str, Any]] = []
    for uid in ids:
        log(f"用户资料：{uid}")
        try:
            success, msg, res = apis.get_user_info(uid)
        except Exception as e:  # noqa: BLE001
            log(f"用户 {uid} 获取异常（跳过）：{e}")
            continue
        if not success or not res:
            log(f"用户 {uid} 获取失败（跳过）：{msg}")
            continue
        data = res.get("data") or {}
        if not isinstance(data, dict) or not data.get("basic_info"):
            log(f"用户 {uid} 响应缺 basic_info（跳过）")
            continue
        basic = data.get("basic_info") or {}
        interactions = data.get("interactions") or []

        def count(idx: int) -> str:
            return str((interactions[idx].get("count", ""))) if idx < len(interactions) else ""

        rows.append({
            "user_id": uid,
            "author_user_id": uid,
            "nickname": basic.get("nickname", ""),
            "desc": basic.get("desc", ""),
            "red_id": basic.get("red_id", ""),
            "gender": basic.get("gender", ""),
            "ip_location": basic.get("ip_location", ""),
            "home_url": f"https://www.xiaohongshu.com/user/profile/{uid}",
            "follows": count(0),   # 关注数
            "fans": count(1),      # 粉丝数（normalize 按 '万/亿' 字符串解析）
            "interaction": count(2),  # 获赞与收藏
        })
    path = append_jsonl(args.data_dir, "creators", "creator", rows)
    log(f"落盘 {len(rows)} 条资料 → {path}")
    return 0 if rows else 1


def do_probe(_args) -> int:
    """环境自检：import 全链 + 签名运行时可用（等价于 MediaCrawler 的 run.py --help）。"""
    import execjs

    try:
        rt = execjs.get()
        rt_name = rt.name
    except Exception as e:  # noqa: BLE001
        print(f"签名运行时不可用：{e}", file=sys.stderr, flush=True)
        return 1
    # 触发全部关键依赖的 import（curl_cffi / requests / qrcode / cryptography）
    from apis.xhs_pc_apis import XHS_Apis  # noqa: F401
    from apis.xhs_pc_login_apis import XHSLoginApi  # noqa: F401

    print(f"Spider_XHS 就绪（签名运行时：{rt_name}）", flush=True)
    return 0


def parse_args(argv: Optional[List[str]] = None):
    p = argparse.ArgumentParser(description="brandsale 小红书采集执行器（Spider_XHS 后端）")
    p.add_argument("--op", required=True,
                   choices=("probe", "login", "check", "search", "content_detail", "comments", "creator"))
    p.add_argument("--spider-dir", default=DEFAULT_SPIDER_DIR)
    p.add_argument("--session-file", default="")
    p.add_argument("--data-dir", default="")
    p.add_argument("--keyword", default="")
    p.add_argument("--note-id", default="")
    p.add_argument("--creator-ids", default="")
    p.add_argument("--max-items", type=int, default=50)
    p.add_argument("--max-comments", type=int, default=100)
    p.add_argument("--sub-comments", default="false")
    p.add_argument("--timeout", type=int, default=180)
    p.add_argument("--qr-ttl", type=int, default=120)
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    args.sub_comments = str(args.sub_comments).lower() in ("1", "true", "yes", "on")
    setup_path(args.spider_dir)

    if args.op == "probe":
        return do_probe(args)

    # 其余算子都要先能 import 上游包
    from apis.xhs_pc_apis import XHS_Apis

    if args.op == "login":
        return do_login(args)
    if args.op == "check":
        return do_check(args)

    # 采集算子：恢复会话 → bootstrap → 执行
    if not args.session_file:
        print("缺少 --session-file", file=sys.stderr, flush=True)
        return 4
    if args.op in ("search",) and not args.keyword:
        print("search 需要 --keyword", file=sys.stderr, flush=True)
        return 4
    if args.op in ("content_detail", "comments") and not args.note_id:
        print(f"{args.op} 需要 --note-id", file=sys.stderr, flush=True)
        return 4
    if args.op == "creator" and not args.creator_ids:
        print("creator 需要 --creator-ids", file=sys.stderr, flush=True)
        return 4

    try:
        auth = load_auth(args.session_file)
    except Exception as e:  # noqa: BLE001
        print(f"登录态不可用：{e}", file=sys.stderr, flush=True)
        return 5
    apis = XHS_Apis(auth).bootstrap()

    if args.op == "search":
        return do_search(args, apis)
    if args.op == "content_detail":
        return do_content_detail(args, apis)
    if args.op == "comments":
        return do_comments(args, apis)
    if args.op == "creator":
        return do_creator(args, apis)
    print(f"未知算子：{args.op}", file=sys.stderr, flush=True)
    return 4


if __name__ == "__main__":
    sys.exit(main())
