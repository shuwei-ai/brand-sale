# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/store/douyin/__init__.py
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
# @Time    : 2024/1/14 18:46
# @Desc    :
from typing import List

import config
from media_platform.douyin.media import extract_cover_url, extract_image_urls, extract_video_urls
from var import source_keyword_var
from tools.user_hash import anonymize_user_id, mask_nickname

from ._store_impl import *


class DouyinStoreFactory:
    STORES = {
        "json": DouyinJsonStoreImplement,
        "jsonl": DouyinJsonlStoreImplement,
    }

    @staticmethod
    def create_store() -> AbstractStore:
        store_class = DouyinStoreFactory.STORES.get(config.SAVE_DATA_OPTION)
        if not store_class:
            raise ValueError("[DouyinStoreFactory.create_store] Invalid save option only supported csv or db or json or sqlite or mongodb or excel ...")
        return store_class()


def _extract_comment_image_list(comment_item: Dict) -> List[str]:
    """
    Extract comment image list

    Args:
        comment_item (Dict): Douyin comment

    Returns:
        List[str]: Comment image list
    """
    images_res: List[str] = []
    image_list: List[Dict] = comment_item.get("image_list", [])

    if not image_list:
        return []

    for image in image_list:
        image_url_list = image.get("origin_url", {}).get("url_list", [])
        if image_url_list and len(image_url_list) > 1:
            images_res.append(image_url_list[1])

    return images_res


def _extract_music_download_url(aweme_detail: Dict) -> str:
    """
    Extract music download URL

    Args:
        aweme_detail (Dict): Douyin video

    Returns:
        str: Music download URL
    """
    music_item = aweme_detail.get("music", {})
    play_url = music_item.get("play_url", {})
    music_url = play_url.get("uri", "")
    return music_url


async def update_douyin_aweme(aweme_item: Dict):
    aweme_id = aweme_item.get("aweme_id")
    user_info = aweme_item.get("author", {})
    interact_info = aweme_item.get("statistics", {})
    save_content_item = {
        "aweme_id": aweme_id,
        "aweme_type": str(aweme_item.get("aweme_type")),
        "title": aweme_item.get("desc", ""),
        "desc": aweme_item.get("desc", ""),
        "create_time": aweme_item.get("create_time"),
        "creator_hash": anonymize_user_id(user_info.get("uid")),  # 创作者匿名哈希(不存原始 uid)
        # 平台原始标识：优先 sec_uid（个人主页接口 `/aweme/v1/web/user/profile/other/`
        # 正是按它查的），没有则退回 uid。只用于"按主页补采资料"，不用于展示。
        "author_user_id": str(user_info.get("sec_uid") or user_info.get("uid") or ""),
        "nickname": mask_nickname(user_info.get("nickname")),  # 用户昵称（完整保留）
        "liked_count": str(interact_info.get("digg_count")),
        "collected_count": str(interact_info.get("collect_count")),
        "comment_count": str(interact_info.get("comment_count")),
        "share_count": str(interact_info.get("share_count")),
        "last_modify_ts": utils.get_current_timestamp(),
        "aweme_url": f"https://www.douyin.com/video/{aweme_id}",
        "cover_url": extract_cover_url(aweme_item),
        "video_download_url": (extract_video_urls(aweme_item) or [""])[0],
        "music_download_url": _extract_music_download_url(aweme_item),
        "note_download_url": ",".join(extract_image_urls(aweme_item)),
        "source_keyword": source_keyword_var.get(),
    }
    utils.logger.info(f"[store.douyin.update_douyin_aweme] douyin aweme id:{aweme_id}, title:{save_content_item.get('title')}")
    await DouyinStoreFactory.create_store().store_content(content_item=save_content_item)


async def batch_update_dy_aweme_comments(aweme_id: str, comments: List[Dict]):
    if not comments:
        return
    for comment_item in comments:
        await update_dy_aweme_comment(aweme_id, comment_item)


async def update_dy_aweme_comment(aweme_id: str, comment_item: Dict):
    comment_aweme_id = comment_item.get("aweme_id")
    if aweme_id != comment_aweme_id:
        utils.logger.error(f"[store.douyin.update_dy_aweme_comment] comment_aweme_id: {comment_aweme_id} != aweme_id: {aweme_id}")
        return
    user_info = comment_item.get("user", {})
    comment_id = comment_item.get("cid")
    parent_comment_id = comment_item.get("reply_id", "0")
    save_comment_item = {
        "comment_id": comment_id,
        "create_time": comment_item.get("create_time"),
        "aweme_id": aweme_id,
        "content": comment_item.get("text"),
        "creator_hash": anonymize_user_id(user_info.get("uid")),  # 创作者匿名哈希(不存原始 uid)
        "nickname": mask_nickname(user_info.get("nickname")),  # 用户昵称（完整保留）
        "sub_comment_count": str(comment_item.get("reply_comment_total", 0)),
        "like_count": (comment_item.get("digg_count") if comment_item.get("digg_count") else 0),
        "last_modify_ts": utils.get_current_timestamp(),
        "parent_comment_id": parent_comment_id,
        "pictures": ",".join(_extract_comment_image_list(comment_item)),
    }
    utils.logger.info(f"[store.douyin.update_dy_aweme_comment] douyin aweme comment: {comment_id}, content: {save_comment_item.get('content')}")

    await DouyinStoreFactory.create_store().store_comment(comment_item=save_comment_item)


async def save_creator(user_id: str, creator: Dict):
    """保存抖音创作者个人主页资料。

    数据源：`/aweme/v1/web/user/profile/other/`（内核 `DouYinClient.get_user_info`），
    返回 `{"user": {...}}`，其中 `follower_count` 就是主页上显示的粉丝数，
    另有 `following_count`（关注）、`total_favorited`（获赞）、`aweme_count`（作品数）。
    这些都是个人主页公开展示的统计，不是画像字段 —— 不取头像/签名/地区。

    为什么不再空实现：报告人选页的"粉丝量"一列此前恒为"未采集"，业主明确要求
    "报告里要有实际的数据"。抖音的内容行（search 结果）里**不带**作者粉丝数，
    只有这个主页接口带，所以必须单独打一次。
    """
    user = (creator or {}).get("user") or {}
    if not user:
        return
    sec_uid = str(user.get("sec_uid") or user_id or "")
    local_db_item = {
        "creator_hash": anonymize_user_id(user.get("uid") or user_id),
        "user_id": str(user.get("uid") or user_id or ""),
        "sec_uid": sec_uid,
        "nickname": mask_nickname(user.get("nickname")),  # 账号昵称（完整保留）
        "fans": user.get("follower_count", ""),  # 粉丝数（主页公开）
        "follows": user.get("following_count", ""),  # 关注数
        "liked": user.get("total_favorited", ""),  # 获赞总数
        "contents": user.get("aweme_count", ""),  # 作品数
        "home_url": f"https://www.douyin.com/user/{sec_uid}" if sec_uid else "",
        "source_keyword": source_keyword_var.get(),
        "last_modify_ts": utils.get_current_timestamp(),
    }
    utils.logger.info(f"[store.douyin.save_creator] douyin creator: {local_db_item}")
    await DouyinStoreFactory.create_store().store_creator(local_db_item)
