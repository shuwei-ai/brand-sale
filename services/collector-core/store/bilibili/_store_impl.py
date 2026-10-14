# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/store/bilibili/_store_impl.py
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
# @Author  : persist1@126.com
# @Time    : 2025/9/5 19:34
# @Desc    : Bilibili storage implementation class
import asyncio
import csv
import json
import os
import pathlib
from typing import Dict

import aiofiles

import config
from base.base_crawler import AbstractStore
from tools.async_file_writer import AsyncFileWriter
from tools import utils
from var import crawler_type_var


class BiliJsonStoreImplement(AbstractStore):
    def __init__(self):
        self.file_writer = AsyncFileWriter(
            crawler_type=crawler_type_var.get(),
            platform="bili"
        )

    async def store_content(self, content_item: Dict):
        """
        content JSON storage implementation
        Args:
            content_item:

        Returns:

        """
        await self.file_writer.write_single_item_to_json(
            item=content_item,
            item_type="contents"
        )

    async def store_comment(self, comment_item: Dict):
        """
        comment JSON storage implementation
        Args:
            comment_item:

        Returns:

        """
        await self.file_writer.write_single_item_to_json(
            item=comment_item,
            item_type="comments"
        )

    async def store_creator(self, creator: Dict):
        """
        creator JSON storage implementation
        Args:
            creator:

        Returns:

        """
        await self.file_writer.write_single_item_to_json(
            item=creator,
            item_type="creators"
        )

    async def store_contact(self, contact_item: Dict):
        """
        creator contact JSON storage implementation
        Args:
            contact_item: creator's contact item dict

        Returns:

        """
        await self.file_writer.write_single_item_to_json(
            item=contact_item,
            item_type="contacts"
        )

    async def store_dynamic(self, dynamic_item: Dict):
        """
        creator dynamic JSON storage implementation
        Args:
            dynamic_item: creator's contact item dict

        Returns:

        """
        await self.file_writer.write_single_item_to_json(
            item=dynamic_item,
            item_type="dynamics"
        )



class BiliJsonlStoreImplement(AbstractStore):
    def __init__(self):
        self.file_writer = AsyncFileWriter(
            crawler_type=crawler_type_var.get(),
            platform="bili"
        )

    async def store_content(self, content_item: Dict):
        await self.file_writer.write_to_jsonl(
            item=content_item,
            item_type="contents"
        )

    async def store_comment(self, comment_item: Dict):
        await self.file_writer.write_to_jsonl(
            item=comment_item,
            item_type="comments"
        )

    async def store_creator(self, creator: Dict):
        await self.file_writer.write_to_jsonl(
            item=creator,
            item_type="creators"
        )

    async def store_contact(self, contact_item: Dict):
        await self.file_writer.write_to_jsonl(
            item=contact_item,
            item_type="contacts"
        )

    async def store_dynamic(self, dynamic_item: Dict):
        await self.file_writer.write_to_jsonl(
            item=dynamic_item,
            item_type="dynamics"
        )

