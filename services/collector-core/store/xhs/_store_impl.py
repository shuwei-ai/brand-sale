# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/store/xhs/_store_impl.py
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

# @Author  : persist1@126.com
# @Time    : 2025/9/5 19:34
# @Desc    : Xiaohongshu storage implementation class
import json
import os
from datetime import datetime
from typing import List, Dict, Any


from base.base_crawler import AbstractStore

from tools.async_file_writer import AsyncFileWriter
from tools.time_util import get_current_timestamp
from var import crawler_type_var
from tools import utils

class XhsJsonStoreImplement(AbstractStore):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.writer = AsyncFileWriter(platform="xhs", crawler_type=crawler_type_var.get())

    async def store_content(self, content_item: Dict):
        """
        store content data to json file
        :param content_item:
        :return:
        """
        await self.writer.write_single_item_to_json(item_type="contents", item=content_item)

    async def store_comment(self, comment_item: Dict):
        """
        store comment data to json file
        :param comment_item:
        :return:
        """
        await self.writer.write_single_item_to_json(item_type="comments", item=comment_item)

    async def store_creator(self, creator_item: Dict):
        """
        store creator (homepage profile) to json file

        个人主页资料（昵称/简介/粉丝数/获赞与收藏）是**公开信息**，业主明确要求
        "报告里要有实际的数据"，故不再做空操作 —— 但只取主页公开展示的那些字段，
        不取头像/性别/IP 归属地等可定位真人的画像（见 tools/user_hash.py 的口径）。
        """
        await self.writer.write_single_item_to_json(item_type="creators", item=creator_item)

    def flush(self):
        """
        flush data to json file
        :return:
        """
        pass



class XhsJsonlStoreImplement(AbstractStore):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.writer = AsyncFileWriter(platform="xhs", crawler_type=crawler_type_var.get())

    async def store_content(self, content_item: Dict):
        await self.writer.write_to_jsonl(item_type="contents", item=content_item)

    async def store_comment(self, comment_item: Dict):
        await self.writer.write_to_jsonl(item_type="comments", item=comment_item)

    async def store_creator(self, creator_item: Dict):
        await self.writer.write_to_jsonl(item_type="creators", item=creator_item)

    def flush(self):
        pass

