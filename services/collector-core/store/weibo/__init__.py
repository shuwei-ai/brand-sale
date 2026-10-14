# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/store/weibo/__init__.py
# GitHub: https://github.com/NanmiCoder
# Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1
#

# 声明：本代码仅供学习和研究目的使用。使用者应遵守以下原则：
# 1. 不得用于任何商业用途。
# 2. 使用时应遵守目标平台的使用条款和robots.txt规则。
# 3. 不得进行大规模爬取或对平台造成运营干扰。
# 4. 应合理控制请求频率，避免给目标平台带来不必要的负担。
# 5. 不得用于任何非法或不当的用途。
#
# 详细许可条款请参阅项目根目录下的LICENSE文件。
# 使用本代码即表示您同意遵守上述原则和LICENSE中的所有条款。

# -*- coding: utf-8 -*-
# @Author  : relakkes@gmail.com
# @Time    : 2024/1/14 21:34
# @Desc    :

import re
from typing import List

from tools.user_hash import anonymize_user_id, mask_nickname
from var import source_keyword_var

from ._store_impl import *


class WeibostoreFactory:
    STORES = {
        "json": WeiboJsonStoreImplement,
        "jsonl": WeiboJsonlStoreImplement,
    }

    @staticmethod
    def create_store() -> AbstractStore:
        store_class = WeibostoreFactory.STORES.get(config.SAVE_DATA_OPTION)
        if not store_class:
            raise ValueError("[WeibotoreFactory.create_store] Invalid save option only supported csv or db or json or sqlite or mongodb or excel ...")
        return store_class()


async def batch_update_weibo_notes(note_list: List[Dict]):
    """
    Batch update weibo notes
    Args:
        note_list:

    Returns:

    """
    if not note_list:
        return
    for note_item in note_list:
        await update_weibo_note(note_item)


async def update_weibo_note(note_item: Dict):
    """
    Update weibo note
    Args:
        note_item:

    Returns:

    """
    if not note_item:
        return

    mblog: Dict = note_item.get("mblog") or {}
    user_info: Dict = mblog.get("user") or {}
    note_id = mblog.get("id")
    content_text = mblog.get("text")
    clean_text = re.sub(r"<.*?>", "", content_text)
    # 原始 user_id 匿名化为 creator_hash（仅作分组键）；昵称**完整保留**（业主明确要求不要打码）；
    # 不采集头像/主页链接/性别/IP 归属地等可定位真人的信息。
    save_content_item = {
        # Weibo information
        "note_id": note_id,
        "content": clean_text,
        "create_time": utils.rfc2822_to_timestamp(mblog.get("created_at")),
        "create_date_time": str(utils.rfc2822_to_china_datetime(mblog.get("created_at"))),
        "liked_count": str(mblog.get("attitudes_count", 0)),
        "comments_count": str(mblog.get("comments_count", 0)),
        "shared_count": str(mblog.get("reposts_count", 0)),
        "last_modify_ts": utils.get_current_timestamp(),
        "note_url": f"https://m.weibo.cn/detail/{note_id}",

        # 创作者信息（仅 ID 匿名化，昵称完整保留；不含 avatar/gender/profile_url/ip_location）
        "creator_hash": anonymize_user_id(user_info.get("id")),
        # 平台原始 uid：仅用于"按个人主页补采粉丝数"（微博主页接口按 uid 查），不展示
        "author_user_id": str(user_info.get("id") or ""),
        "nickname": mask_nickname(user_info.get("screen_name", "")),
        "source_keyword": source_keyword_var.get(),
    }
    utils.logger.info(f"[store.weibo.update_weibo_note] weibo note id:{note_id}, title:{save_content_item.get('content')[:24]} ...")
    await WeibostoreFactory.create_store().store_content(content_item=save_content_item)


async def batch_update_weibo_note_comments(note_id: str, comments: List[Dict]):
    """
    Batch update weibo note comments
    Args:
        note_id:
        comments:

    Returns:

    """
    if not comments:
        return
    for comment_item in comments:
        await update_weibo_note_comment(note_id, comment_item)


async def update_weibo_note_comment(note_id: str, comment_item: Dict):
    """
    Update weibo note comment
    Args:
        note_id: weibo note id
        comment_item: weibo comment item

    Returns:

    """
    if not comment_item or not note_id:
        return
    comment_id = str(comment_item.get("id"))
    user_info: Dict = comment_item.get("user") or {}
    content_text = comment_item.get("text")
    clean_text = re.sub(r"<.*?>", "", content_text)
    # 原始 user_id 匿名化为 creator_hash（仅作分组键）；昵称**完整保留**（业主明确要求不要打码）；
    # 不采集头像/主页链接/性别/IP 归属地等可定位真人的信息。
    save_comment_item = {
        "comment_id": comment_id,
        "create_time": utils.rfc2822_to_timestamp(comment_item.get("created_at")),
        "create_date_time": str(utils.rfc2822_to_china_datetime(comment_item.get("created_at"))),
        "note_id": note_id,
        "content": clean_text,
        "sub_comment_count": str(comment_item.get("total_number", 0)),
        "comment_like_count": str(comment_item.get("like_count", 0)),
        "last_modify_ts": utils.get_current_timestamp(),
        "parent_comment_id": comment_item.get("rootid", ""),

        # 创作者信息（仅 ID 匿名化，昵称完整保留；不含原始 user_id/avatar/gender/profile_url/ip_location）
        "creator_hash": anonymize_user_id(user_info.get("id")),
        "nickname": mask_nickname(user_info.get("screen_name", "")),
    }
    utils.logger.info(f"[store.weibo.update_weibo_note_comment] Weibo note comment: {comment_id}, content: {save_comment_item.get('content', '')[:24]} ...")
    await WeibostoreFactory.create_store().store_comment(comment_item=save_comment_item)


async def save_creator(user_id: str, user_info: Dict):
    """保存微博博主主页资料（粉丝数等主页公开统计）。

    数据源：内核 `WeiboClient.get_creator_info_by_id` → `/api/container/getIndex`
    的 `userInfo`，里面 `followers_count` / `follow_count` / `statuses_count`
    就是主页顶上那三个数字。只落这三个统计与昵称/简介，不落画像字段。
    """
    if not user_info:
        return
    uid = str(user_info.get("id") or user_id or "")
    local_db_item = {
        "creator_hash": anonymize_user_id(uid),
        "user_id": uid,
        "nickname": mask_nickname(user_info.get("screen_name")),  # 账号昵称（完整保留）
        "desc": user_info.get("description", ""),  # 简介
        "fans": user_info.get("followers_count", ""),  # 粉丝数
        "follows": user_info.get("follow_count", ""),  # 关注数
        "contents": user_info.get("statuses_count", ""),  # 微博数
        "home_url": user_info.get("profile_url") or (f"https://weibo.com/u/{uid}" if uid else ""),
        "source_keyword": source_keyword_var.get(),
        "last_modify_ts": utils.get_current_timestamp(),
    }
    utils.logger.info(f"[store.weibo.save_creator] weibo creator: {local_db_item}")
    await WeibostoreFactory.create_store().store_creator(local_db_item)
