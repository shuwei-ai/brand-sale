# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/bilibili/core.py
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
# @Time    : 2023/12/2 18:44
# @Desc    : Bilibili Crawler

import asyncio
import os
import sys
# import random  # Removed as we now use fixed config.CRAWLER_MAX_SLEEP_SEC intervals
from asyncio import Task
from typing import Dict, List, Optional, Tuple, Union
from datetime import datetime, timedelta

from playwright.async_api import (
    BrowserContext,
    BrowserType,
    Page,
    Playwright,
    async_playwright,
)
from playwright._impl._errors import TargetClosedError

import config
from base.base_crawler import AbstractCrawler
from media_downloader import MediaDownloader, is_ffmpeg_available
from proxy.proxy_ip_pool import IpInfoModel, create_ip_pool
from store import bilibili as bilibili_store
from tools import utils
from tools.user_hash import anonymize_user_id, mask_nickname
from tools.cdp_browser import CDPBrowserManager
from var import crawler_type_var, source_keyword_var

from . import media as bili_media
from .client import BilibiliClient
from .exception import DataFetchError
from .field import SearchOrderType
from .help import parse_video_info_from_url, parse_creator_info_from_url
from .login import BilibiliLogin


class BilibiliCrawler(AbstractCrawler):
    context_page: Page
    bili_client: BilibiliClient
    browser_context: BrowserContext
    cdp_manager: Optional[CDPBrowserManager]

    def __init__(self):
        self.index_url = "https://www.bilibili.com"
        self.cookie_urls = [self.index_url]
        self.user_agent = utils.get_user_agent()
        self.cdp_manager = None
        self.ip_proxy_pool = None  # Proxy IP pool for automatic proxy refresh
        self._media_downloader: Optional[MediaDownloader] = None
        # 本次运行已落过资料的 UP 主 mid：一次搜索里同一 UP 常有多条视频，
        # 去重后 relation/stat 只打一次（见 save_up_info）
        self._saved_up_mids: set = set()

    async def start(self):
        playwright_proxy_format, httpx_proxy_format = None, None
        if config.ENABLE_IP_PROXY:
            self.ip_proxy_pool = await create_ip_pool(config.IP_PROXY_POOL_COUNT, enable_validate_ip=True)
            ip_proxy_info: IpInfoModel = await self.ip_proxy_pool.get_proxy()
            playwright_proxy_format, httpx_proxy_format = utils.format_proxy_info(ip_proxy_info)

        async with async_playwright() as playwright:
            # Choose launch mode based on configuration
            if config.ENABLE_CDP_MODE:
                utils.logger.info("[BilibiliCrawler] Launching browser using CDP mode")
                self.browser_context = await self.launch_browser_with_cdp(
                    playwright,
                    playwright_proxy_format,
                    self.user_agent,
                    headless=config.CDP_HEADLESS,
                )
            else:
                utils.logger.info("[BilibiliCrawler] Launching browser using standard mode")
                # Launch a browser context.
                chromium = playwright.chromium
                self.browser_context = await self.launch_browser(chromium, None, self.user_agent, headless=config.HEADLESS)
                # stealth.min.js is a js script to prevent the website from detecting the crawler.
                await self.browser_context.add_init_script(path="libs/stealth.min.js")

            self.context_page = await self.browser_context.new_page()
            await self.context_page.goto(self.index_url, wait_until="domcontentloaded", timeout=60000)

            # Create a client to interact with the xiaohongshu website.
            self.bili_client = await self.create_bilibili_client(httpx_proxy_format)
            if not await self.bili_client.pong():
                login_obj = BilibiliLogin(
                    login_type=config.LOGIN_TYPE,
                    login_phone="",  # your phone number
                    browser_context=self.browser_context,
                    context_page=self.context_page,
                    cookie_str=config.COOKIES,
                )
                await login_obj.begin()
                await self.bili_client.update_cookies(
                    browser_context=self.browser_context,
                    urls=self.cookie_urls,
                )
                # 登录流程结束后再校验一次，宁可在这里失败也不要带着未登录状态跑完全程：
                # B 站的清晰度由 playurl 依据 Cookie 决定，死会话不会报错，
                # 只会把带 get_media 的视频静默限制在 480P
                if not await self.bili_client.pong():
                    utils.logger.error(
                        "[BilibiliCrawler.start] 登录流程结束后仍未登录：请确认扫码已完成、"
                        "或 config.COOKIES 是否有效。已终止，否则视频会被静默限制在 480P。"
                    )
                    sys.exit(1)

            crawler_type_var.set(config.CRAWLER_TYPE)
            if config.CRAWLER_TYPE == "search":
                await self.search()
            elif config.CRAWLER_TYPE == "detail":
                # Get the information and comments of the specified post
                await self.get_specified_videos(config.BILI_SPECIFIED_ID_LIST)
            elif config.CRAWLER_TYPE == "creator":
                if config.PROFILE_ONLY:
                    # 只要主页资料（粉丝数等）：走 get_all_creator_details —— 它逐 id 调
                    # get_creator_details，那里会落主页统计并跳过动态。
                    # **不能**走下面的 get_creator_videos：那条路会把这个 UP 的**全部作品**
                    # 连评论一起爬（实测一个补采任务跑了 3 分钟还在抓评论，而所需数据
                    # 早在第一秒就落盘了），既慢又平白加重平台负担。
                    utils.logger.info(
                        "[BilibiliCrawler.start] profile-only：只取 UP 主主页资料，跳过作品抓取"
                    )
                    await self.get_all_creator_details(config.BILI_CREATOR_ID_LIST)
                elif config.CREATOR_MODE:
                    for creator_url in config.BILI_CREATOR_ID_LIST:
                        try:
                            creator_info = parse_creator_info_from_url(creator_url)
                            utils.logger.info(f"[BilibiliCrawler.start] Parsed creator ID: {creator_info.creator_id} from {creator_url}")
                            await self.get_creator_videos(int(creator_info.creator_id))
                        except ValueError as e:
                            utils.logger.error(f"[BilibiliCrawler.start] Failed to parse creator URL: {e}")
                            continue
                else:
                    await self.get_all_creator_details(config.BILI_CREATOR_ID_LIST)
            else:
                pass
            utils.logger.info("[BilibiliCrawler.start] Bilibili Crawler finished ...")

    async def search(self):
        """
        search bilibili video
        """
        # Search for video and retrieve their comment information.
        if config.BILI_SEARCH_MODE == "normal":
            await self.search_by_keywords()
        elif config.BILI_SEARCH_MODE == "all_in_time_range":
            await self.search_by_keywords_in_time_range(daily_limit=False)
        elif config.BILI_SEARCH_MODE == "daily_limit_in_time_range":
            await self.search_by_keywords_in_time_range(daily_limit=True)
        else:
            utils.logger.warning(f"Unknown BILI_SEARCH_MODE: {config.BILI_SEARCH_MODE}")

    @staticmethod
    async def get_pubtime_datetime(
        start: str = config.START_DAY,
        end: str = config.END_DAY,
    ) -> Tuple[str, str]:
        """
        Get bilibili publish start timestamp pubtime_begin_s and publish end timestamp pubtime_end_s
        ---
        :param start: Publish date start time, YYYY-MM-DD
        :param end: Publish date end time, YYYY-MM-DD

        Note
        ---
        - Search time range is from start to end, including both start and end
        - To search content from the same day, to include search content from that day, pubtime_end_s should be pubtime_begin_s plus one day minus one second, i.e., the last second of start day
            - For example, searching only 2024-01-05 content, pubtime_begin_s = 1704384000, pubtime_end_s = 1704470399
              Converted to readable datetime objects: pubtime_begin_s = datetime.datetime(2024, 1, 5, 0, 0), pubtime_end_s = datetime.datetime(2024, 1, 5, 23, 59, 59)
        - To search content from start to end, to include search content from end day, pubtime_end_s should be pubtime_end_s plus one day minus one second, i.e., the last second of end day
            - For example, searching 2024-01-05 - 2024-01-06 content, pubtime_begin_s = 1704384000, pubtime_end_s = 1704556799
              Converted to readable datetime objects: pubtime_begin_s = datetime.datetime(2024, 1, 5, 0, 0), pubtime_end_s = datetime.datetime(2024, 1, 6, 23, 59, 59)
        """
        # Convert start and end to datetime objects
        start_day: datetime = datetime.strptime(start, "%Y-%m-%d")
        end_day: datetime = datetime.strptime(end, "%Y-%m-%d")
        if start_day > end_day:
            raise ValueError("Wrong time range, please check your start and end argument, to ensure that the start cannot exceed end")
        elif start_day == end_day:  # Searching content from the same day
            end_day = (start_day + timedelta(days=1) - timedelta(seconds=1))  # Set end_day to start_day + 1 day - 1 second
        else:  # Searching from start to end
            end_day = (end_day + timedelta(days=1) - timedelta(seconds=1))  # Set end_day to end_day + 1 day - 1 second
        # Convert back to timestamps
        return str(int(start_day.timestamp())), str(int(end_day.timestamp()))

    async def search_by_keywords(self):
        """
        search bilibili video with keywords in normal mode
        :return:
        """
        utils.logger.info("[BilibiliCrawler.search_by_keywords] Begin search bilibli keywords")
        bili_limit_count = 20  # bilibili limit page fixed value
        if config.CRAWLER_MAX_NOTES_COUNT < bili_limit_count:
            config.CRAWLER_MAX_NOTES_COUNT = bili_limit_count
        start_page = config.START_PAGE  # start page number
        for keyword in config.KEYWORDS.split(","):
            source_keyword_var.set(keyword)
            utils.logger.info(f"[BilibiliCrawler.search_by_keywords] Current search keyword: {keyword}")
            page = 1
            while (page - start_page + 1) * bili_limit_count <= config.CRAWLER_MAX_NOTES_COUNT:
                if page < start_page:
                    utils.logger.info(f"[BilibiliCrawler.search_by_keywords] Skip page: {page}")
                    page += 1
                    continue

                utils.logger.info(f"[BilibiliCrawler.search_by_keywords] search bilibili keyword: {keyword}, page: {page}")
                video_id_list: List[str] = []
                videos_res = await self.bili_client.search_video_by_keyword(
                    keyword=keyword,
                    page=page,
                    page_size=bili_limit_count,
                    order=SearchOrderType.DEFAULT,
                    pubtime_begin_s=0,  # Publish date start timestamp
                    pubtime_end_s=0,  # Publish date end timestamp
                )
                video_list: List[Dict] = videos_res.get("result")

                if not video_list:
                    utils.logger.info(f"[BilibiliCrawler.search_by_keywords] No more videos for '{keyword}', moving to next keyword.")
                    break

                semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY_NUM)
                task_list = []
                try:
                    task_list = [self.get_video_info_task(aid=video_item.get("aid"), bvid="", semaphore=semaphore) for video_item in video_list]
                except Exception as e:
                    utils.logger.warning(f"[BilibiliCrawler.search_by_keywords] error in the task list. The video for this page will not be included. {e}")
                video_items = await asyncio.gather(*task_list)
                for video_item in video_items:
                    if video_item:
                        video_id_list.append(video_item.get("View").get("aid"))
                        await bilibili_store.update_bilibili_video(video_item)
                        await self.save_up_info(video_item)
                        await self.download_media(video_item, semaphore)
                page += 1

                # Sleep after page navigation
                await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
                utils.logger.info(f"[BilibiliCrawler.search_by_keywords] Sleeping for {config.CRAWLER_MAX_SLEEP_SEC} seconds after page {page-1}")

                await self.batch_get_video_comments(video_id_list)

    async def search_by_keywords_in_time_range(self, daily_limit: bool):
        """
        Search bilibili video with keywords in a given time range.
        :param daily_limit: if True, strictly limit the number of notes per day and total.
        """
        utils.logger.info(f"[BilibiliCrawler.search_by_keywords_in_time_range] Begin search with daily_limit={daily_limit}")
        bili_limit_count = 20
        start_page = config.START_PAGE

        for keyword in config.KEYWORDS.split(","):
            source_keyword_var.set(keyword)
            utils.logger.info(f"[BilibiliCrawler.search_by_keywords_in_time_range] Current search keyword: {keyword}")
            total_notes_crawled_for_keyword = 0

            # 原为 pd.date_range(freq="D")。只为一个按天的日期迭代引入 pandas 不值当，
            # 换成等价的纯标准库实现。
            _day0 = datetime.strptime(config.START_DAY, "%Y-%m-%d")
            _day1 = datetime.strptime(config.END_DAY, "%Y-%m-%d")
            for _di in range((_day1 - _day0).days + 1):
                day = _day0 + timedelta(days=_di)
                if (daily_limit and total_notes_crawled_for_keyword >= config.CRAWLER_MAX_NOTES_COUNT):
                    utils.logger.info(f"[BilibiliCrawler.search] Reached CRAWLER_MAX_NOTES_COUNT limit for keyword '{keyword}', skipping remaining days.")
                    break

                if (not daily_limit and total_notes_crawled_for_keyword >= config.CRAWLER_MAX_NOTES_COUNT):
                    utils.logger.info(f"[BilibiliCrawler.search] Reached CRAWLER_MAX_NOTES_COUNT limit for keyword '{keyword}', skipping remaining days.")
                    break

                pubtime_begin_s, pubtime_end_s = await self.get_pubtime_datetime(start=day.strftime("%Y-%m-%d"), end=day.strftime("%Y-%m-%d"))
                page = 1
                notes_count_this_day = 0

                while True:
                    if notes_count_this_day >= config.MAX_NOTES_PER_DAY:
                        utils.logger.info(f"[BilibiliCrawler.search] Reached MAX_NOTES_PER_DAY limit for {day.ctime()}.")
                        break
                    if (daily_limit and total_notes_crawled_for_keyword >= config.CRAWLER_MAX_NOTES_COUNT):
                        utils.logger.info(f"[BilibiliCrawler.search] Reached CRAWLER_MAX_NOTES_COUNT limit for keyword '{keyword}'.")
                        break
                    if (not daily_limit and total_notes_crawled_for_keyword >= config.CRAWLER_MAX_NOTES_COUNT):
                        break

                    try:
                        utils.logger.info(f"[BilibiliCrawler.search] search bilibili keyword: {keyword}, date: {day.ctime()}, page: {page}")
                        video_id_list: List[str] = []
                        videos_res = await self.bili_client.search_video_by_keyword(
                            keyword=keyword,
                            page=page,
                            page_size=bili_limit_count,
                            order=SearchOrderType.DEFAULT,
                            pubtime_begin_s=pubtime_begin_s,
                            pubtime_end_s=pubtime_end_s,
                        )
                        video_list: List[Dict] = videos_res.get("result")

                        if not video_list:
                            utils.logger.info(f"[BilibiliCrawler.search] No more videos for '{keyword}' on {day.ctime()}, moving to next day.")
                            break

                        semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY_NUM)
                        task_list = [self.get_video_info_task(aid=video_item.get("aid"), bvid="", semaphore=semaphore) for video_item in video_list]
                        video_items = await asyncio.gather(*task_list)

                        for video_item in video_items:
                            if video_item:
                                if (daily_limit and total_notes_crawled_for_keyword >= config.CRAWLER_MAX_NOTES_COUNT):
                                    break
                                if (not daily_limit and total_notes_crawled_for_keyword >= config.CRAWLER_MAX_NOTES_COUNT):
                                    break
                                if notes_count_this_day >= config.MAX_NOTES_PER_DAY:
                                    break
                                notes_count_this_day += 1
                                total_notes_crawled_for_keyword += 1
                                video_id_list.append(video_item.get("View").get("aid"))
                                await bilibili_store.update_bilibili_video(video_item)
                                await self.save_up_info(video_item)
                                await self.download_media(video_item, semaphore)

                        page += 1

                        # Sleep after page navigation
                        await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
                        utils.logger.info(f"[BilibiliCrawler.search_by_keywords_in_time_range] Sleeping for {config.CRAWLER_MAX_SLEEP_SEC} seconds after page {page-1}")

                        await self.batch_get_video_comments(video_id_list)

                    except Exception as e:
                        utils.logger.error(f"[BilibiliCrawler.search] Error searching on {day.ctime()}: {e}")
                        break

    async def batch_get_video_comments(self, video_id_list: List[str]):
        """
        batch get video comments
        :param video_id_list:
        :return:
        """
        if not config.ENABLE_GET_COMMENTS:
            utils.logger.info(f"[BilibiliCrawler.batch_get_note_comments] Crawling comment mode is not enabled")
            return

        utils.logger.info(f"[BilibiliCrawler.batch_get_video_comments] video ids:{video_id_list}")
        semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY_NUM)
        task_list: List[Task] = []
        for video_id in video_id_list:
            task = asyncio.create_task(self.get_comments(video_id, semaphore), name=video_id)
            task_list.append(task)
        await asyncio.gather(*task_list)

    async def get_comments(self, video_id: str, semaphore: asyncio.Semaphore):
        """
        get comment for video id
        :param video_id:
        :param semaphore:
        :return:
        """
        async with semaphore:
            try:
                utils.logger.info(f"[BilibiliCrawler.get_comments] begin get video_id: {video_id} comments ...")
                await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
                utils.logger.info(f"[BilibiliCrawler.get_comments] Sleeping for {config.CRAWLER_MAX_SLEEP_SEC} seconds after fetching comments for video {video_id}")
                await self.bili_client.get_video_all_comments(
                    video_id=video_id,
                    crawl_interval=config.CRAWLER_MAX_SLEEP_SEC,
                    is_fetch_sub_comments=config.ENABLE_GET_SUB_COMMENTS,
                    callback=bilibili_store.batch_update_bilibili_video_comments,
                    max_count=config.CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES,
                )

            except DataFetchError as ex:
                utils.logger.error(f"[BilibiliCrawler.get_comments] get video_id: {video_id} comment error: {ex}")
            except Exception as e:
                utils.logger.error(f"[BilibiliCrawler.get_comments] may be been blocked, err:{e}")
                # Propagate the exception to be caught by the main loop
                raise

    async def save_up_info(self, video_item: Dict):
        """保存视频作者（UP 主）的个人主页公开统计。

        为什么在这里而不是 store 层：粉丝数要打 `/x/relation/stat`，而 client 在这个类里。
        两个刻意的取舍：
          · **进程内去重**：一次搜索里同一个 UP 往往有多条视频，按 mid 去重后只查一次，
            否则 20 条视频就是 20 次 relation/stat，纯浪费且容易撞频控。
          · **失败不阻断**：拿不到粉丝数就落一条只有昵称的资料行（报告显示"未采集"），
            绝不因为一个 UP 查不到而让整个视频不被落盘。
        """
        owner: Dict = ((video_item or {}).get("View") or {}).get("owner") or {}
        mid = owner.get("mid")
        if not mid:
            return
        mid_s = str(mid)
        if mid_s in self._saved_up_mids:
            return
        self._saved_up_mids.add(mid_s)
        try:
            stat = await self.bili_client.get_creator_stat(mid)
        except Exception as e:  # noqa: BLE001 - 资料是旁路能力，任何异常都不该影响内容落盘
            utils.logger.warning(f"[BilibiliCrawler.save_up_info] get stat failed for mid {mid_s}: {e}")
            stat = {}
        try:
            await self.bilibili_store_save_up(owner, stat)
        except Exception as e:  # noqa: BLE001
            utils.logger.warning(f"[BilibiliCrawler.save_up_info] save failed for mid {mid_s}: {e}")

    async def bilibili_store_save_up(self, owner: Dict, stat: Dict):
        """把 owner + relation/stat 组装成一条 creator 行。"""
        mid = str(owner.get("mid") or "")
        await bilibili_store.save_creator({
            "creator_hash": anonymize_user_id(mid),
            "user_id": mid,
            "nickname": mask_nickname(owner.get("name")),
            "desc": owner.get("sign", ""),
            "fans": stat.get("follower", ""),
            "follows": stat.get("following", ""),
            "home_url": f"https://space.bilibili.com/{mid}" if mid else "",
        })

    async def get_creator_videos(self, creator_id: int):
        """
        get videos for a creator
        :return:
        """
        ps = 30
        pn = 1
        while True:
            result = await self.bili_client.get_creator_videos(creator_id, pn, ps)
            video_bvids_list = [video["bvid"] for video in result["list"]["vlist"]]
            await self.get_specified_videos(video_bvids_list)
            if int(result["page"]["count"]) <= pn * ps:
                break
            await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
            utils.logger.info(f"[BilibiliCrawler.get_creator_videos] Sleeping for {config.CRAWLER_MAX_SLEEP_SEC} seconds after page {pn}")
            pn += 1

    async def get_specified_videos(self, video_url_list: List[str]):
        """
        get specified videos info from URLs or BV IDs
        :param video_url_list: List of video URLs or BV IDs
        :return:
        """
        utils.logger.info("[BilibiliCrawler.get_specified_videos] Parsing video URLs...")
        # video_id 可能是 BV 号，也可能是纯数字 aid（av 号 / 裸 aid）。
        # 详情接口两者都支持，但必须走对参数位（aid=bvid= 二选一），否则详情取不到。
        parsed: List[tuple] = []
        for video_url in video_url_list:
            try:
                video_info = parse_video_info_from_url(video_url)
                video_id = video_info.video_id
                parsed.append((int(video_id) if video_id.isdigit() else 0, "" if video_id.isdigit() else video_id))
                utils.logger.info(f"[BilibiliCrawler.get_specified_videos] Parsed video ID: {video_id} from {video_url}")
            except ValueError as e:
                utils.logger.error(f"[BilibiliCrawler.get_specified_videos] Failed to parse video URL: {e}")
                continue

        semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY_NUM)
        task_list = [self.get_video_info_task(aid=aid, bvid=bvid, semaphore=semaphore) for aid, bvid in parsed]
        video_details = await asyncio.gather(*task_list)
        video_aids_list = []
        for video_detail in video_details:
            if video_detail is not None:
                video_item_view: Dict = video_detail.get("View")
                video_aid: str = video_item_view.get("aid")
                if video_aid:
                    video_aids_list.append(video_aid)
                await bilibili_store.update_bilibili_video(video_detail)
                await self.save_up_info(video_detail)
                await self.download_media(video_detail, semaphore)
        await self.batch_get_video_comments(video_aids_list)

    async def get_video_info_task(self, aid: int, bvid: str, semaphore: asyncio.Semaphore) -> Optional[Dict]:
        """
        Get video detail task
        :param aid:
        :param bvid:
        :param semaphore:
        :return:
        """
        async with semaphore:
            try:
                result = await self.bili_client.get_video_info(aid=aid, bvid=bvid)

                # Sleep after fetching video details
                await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
                utils.logger.info(f"[BilibiliCrawler.get_video_info_task] Sleeping for {config.CRAWLER_MAX_SLEEP_SEC} seconds after fetching video details {bvid or aid}")

                return result
            except DataFetchError as ex:
                utils.logger.error(f"[BilibiliCrawler.get_video_info_task] Get video detail error: {ex}")
                return None
            except KeyError as ex:
                utils.logger.error(f"[BilibiliCrawler.get_video_info_task] have not fund note detail video_id:{bvid}, err: {ex}")
                return None

    async def get_video_play_url_task(
        self,
        aid: int,
        cid: int,
        semaphore: asyncio.Semaphore,
        fnval: int = bili_media.DASH_FNVAL,
    ) -> Union[Dict, None]:
        """
        Get video play url
        :param aid:
        :param cid:
        :param semaphore:
        :param fnval: 媒体格式位掩码，默认请求 DASH 分轨流
        :return:
        """
        async with semaphore:
            try:
                result = await self.bili_client.get_video_play_url(aid=aid, cid=cid, fnval=fnval)
                return result
            except DataFetchError as ex:
                utils.logger.error(f"[BilibiliCrawler.get_video_play_url_task] Get video play url error: {ex}")
                return None
            except KeyError as ex:
                utils.logger.error(f"[BilibiliCrawler.get_video_play_url_task] have not fund play url from :{aid}|{cid}, err: {ex}")
                return None

    async def create_bilibili_client(self, httpx_proxy: Optional[str]) -> BilibiliClient:
        """
        create bilibili client
        :param httpx_proxy: httpx proxy
        :return: bilibili client
        """
        utils.logger.info("[BilibiliCrawler.create_bilibili_client] Begin create bilibili API client ...")
        cookie_str, cookie_dict = await utils.convert_browser_context_cookies(
            self.browser_context,
            urls=self.cookie_urls,
        )
        bilibili_client_obj = BilibiliClient(
            proxy=httpx_proxy,
            headers={
                "User-Agent": self.user_agent,
                "Cookie": cookie_str,
                "Origin": "https://www.bilibili.com",
                "Referer": "https://www.bilibili.com",
                "Content-Type": "application/json;charset=UTF-8",
            },
            playwright_page=self.context_page,
            cookie_dict=cookie_dict,
            proxy_ip_pool=self.ip_proxy_pool,  # Pass proxy pool for automatic refresh
        )
        return bilibili_client_obj

    async def launch_browser(
        self,
        chromium: BrowserType,
        playwright_proxy: Optional[Dict],
        user_agent: Optional[str],
        headless: bool = True,
    ) -> BrowserContext:
        """
        launch browser and create browser context
        :param chromium: chromium browser
        :param playwright_proxy: playwright proxy
        :param user_agent: user agent
        :param headless: headless mode
        :return: browser context
        """
        utils.logger.info("[BilibiliCrawler.launch_browser] Begin create browser context ...")
        if config.SAVE_LOGIN_STATE:
            # feat issue #14
            # we will save login state to avoid login every time
            user_data_dir = os.path.join(os.getcwd(), "browser_data", config.USER_DATA_DIR % config.PLATFORM)  # type: ignore
            browser_context = await chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                accept_downloads=True,
                headless=headless,
                proxy=playwright_proxy,  # type: ignore
                viewport={
                    "width": 1920,
                    "height": 1080
                },
                user_agent=user_agent,
                channel="chrome",  # Use system's stable Chrome version
            )
            return browser_context
        else:
            # type: ignore
            browser = await chromium.launch(headless=headless, proxy=playwright_proxy, channel="chrome")
            browser_context = await browser.new_context(viewport={"width": 1920, "height": 1080}, user_agent=user_agent)
            return browser_context

    async def launch_browser_with_cdp(
        self,
        playwright: Playwright,
        playwright_proxy: Optional[Dict],
        user_agent: Optional[str],
        headless: bool = True,
    ) -> BrowserContext:
        """
        Launch browser using CDP mode
        """
        try:
            self.cdp_manager = CDPBrowserManager()
            browser_context = await self.cdp_manager.launch_and_connect(
                playwright=playwright,
                playwright_proxy=playwright_proxy,
                user_agent=user_agent,
                headless=headless,
            )

            # Display browser information
            browser_info = await self.cdp_manager.get_browser_info()
            utils.logger.info(f"[BilibiliCrawler] CDP browser info: {browser_info}")

            return browser_context

        except Exception as e:
            utils.logger.error(f"[BilibiliCrawler] CDP mode launch failed, fallback to standard mode: {e}")
            # Fallback to standard mode
            chromium = playwright.chromium
            return await self.launch_browser(chromium, playwright_proxy, user_agent, headless)

    async def close(self):
        """Close browser context"""
        try:
            # If using CDP mode, special handling is required
            if self.cdp_manager:
                await self.cdp_manager.cleanup()
                self.cdp_manager = None
            elif self.browser_context:
                await self.browser_context.close()
            # 措辞刻意从 "Browser context closed" 改成 "session released"：
            # 常驻复用模式下（`--cdp reuse`）这里只断开 CDP 连接，**浏览器是保留的**，
            # 说成 closed 会让人误以为窗口已经没了（见 tools/cdp_browser.py::_detach_from_persistent）。
            utils.logger.info("[BilibiliCrawler.close] Browser session released ...")
        except TargetClosedError:
            utils.logger.warning("[BilibiliCrawler.close] Browser context was already closed.")
        except Exception as e:
            utils.logger.error(f"[BilibiliCrawler.close] An error occurred during close: {e}")

    async def download_media(self, video_item: Dict, semaphore: asyncio.Semaphore):
        """下载 B 站视频与封面。

        优先走 DASH（音视频分轨 + ffmpeg 合流，画质最好）；本机没有 ffmpeg
        或 DASH 流不可用时，降级为 mp4 直链（音视频合一，清晰度受接口限制）。

        :param video_item: 视频详情，需包含 View 字段（含 aid/cid/pic/bvid）
        :param semaphore: 用于限制 playurl 接口请求并发
        """
        if not config.ENABLE_GET_MEDIA:
            return
        try:
            await self._download_media(video_item, semaphore)
        except Exception as exc:
            # 媒体下载是旁路能力：playurl 是额外的接口调用，网络抖动不能中断爬取主流程
            utils.logger.error(f"[BilibiliCrawler.download_media] 媒体下载异常: {exc}")

    async def _download_media(self, video_item: Dict, semaphore: asyncio.Semaphore) -> None:
        video_item_view: Dict = video_item.get("View") or {}
        aid = video_item_view.get("aid")
        cid = video_item_view.get("cid")
        content_id = video_item_view.get("bvid") or (str(aid) if aid else "")
        if not content_id:
            utils.logger.warning("[BilibiliCrawler.download_media] 缺少 aid/bvid，跳过媒体下载")
            return

        downloader = self._get_media_downloader()

        cover_item = bili_media.build_cover_item(video_item_view, content_id)
        if cover_item is not None:
            await downloader.download(cover_item)

        if not aid or not cid:
            utils.logger.warning("[BilibiliCrawler.download_media] 缺少 aid/cid，无法获取播放地址")
            return

        # ffmpeg 是否可用在请求之前就是确定的（进程内缓存），据此一次性决定 fnval：
        # 没装 ffmpeg 却先按 DASH 请求一次，既多打一次风控最敏感的 playurl 接口，
        # 也拿不到可用的 durl
        dash_supported = is_ffmpeg_available()
        play_fnval = bili_media.DASH_FNVAL if dash_supported else bili_media.MP4_FNVAL
        play_info = await self.get_video_play_url_task(aid, cid, semaphore, fnval=play_fnval)
        await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
        if play_info is None:
            utils.logger.error("[BilibiliCrawler.download_media] 获取播放地址失败")
            return

        if dash_supported:
            # 逐档降级：未登录或权限不足时 B 站会返回高清晰度 URL，但实际取流被 CDN 403，
            # 此时退到更低的可用档位往往能成功，比直接放弃（或退回更低质的直链）更好
            quality: Optional[int] = getattr(config, "BILI_QN", 80)
            while quality is not None:
                dash_item = bili_media.build_dash_item(play_info, content_id, preferred_quality=quality)
                if dash_item is None:
                    break
                if await downloader.download(dash_item) is not None:
                    return
                lower_quality = bili_media.next_lower_quality(play_info, quality)
                if lower_quality is None:
                    break
                utils.logger.warning(
                    f"[BilibiliCrawler.download_media] 清晰度 {quality} 取流失败，降级到 {lower_quality}"
                )
                quality = lower_quality

            utils.logger.warning("[BilibiliCrawler.download_media] DASH 路径失败，降级为 mp4 直链")
        else:
            utils.logger.info("[BilibiliCrawler.download_media] 未检测到 ffmpeg，使用 mp4 直链下载（低清晰度）")

        durl_play_info = play_info
        durl_item = bili_media.build_durl_item(durl_play_info, content_id)
        if durl_item is None:
            # DASH 请求不会返回 durl，需要再按 mp4 格式请求一次
            durl_play_info = await self.get_video_play_url_task(
                aid, cid, semaphore, fnval=bili_media.MP4_FNVAL
            ) or {}
            await asyncio.sleep(config.CRAWLER_MAX_SLEEP_SEC)
            durl_item = bili_media.build_durl_item(durl_play_info, content_id)

        if durl_item is None:
            utils.logger.error(
                f"[BilibiliCrawler.download_media] 未能获取到视频直链 aid={aid} cid={cid}"
            )
            return

        segment_count = bili_media.count_durl_segments(durl_play_info)
        if segment_count > 1:
            utils.logger.warning(
                f"[BilibiliCrawler.download_media] 该视频直链被切成 {segment_count} 段，"
                f"当前仅下载体积最大的一段，文件可能不完整；"
                f"确认本机 ffmpeg 可用后走 DASH 路径可获取完整视频"
            )

        await downloader.download(durl_item)

    def _get_media_downloader(self) -> MediaDownloader:
        """惰性创建媒体下载器，并同步最新的代理与 Cookie（两者都会就地刷新）"""
        if self._media_downloader is None:
            self._media_downloader = MediaDownloader(
                platform="bili",
                proxy=getattr(self.bili_client, "proxy", None),
                extra_headers=self._media_headers(),
            )
        else:
            self._media_downloader.update_credentials(
                proxy=getattr(self.bili_client, "proxy", None),
                extra_headers=self._media_headers(),
            )
        return self._media_downloader

    def _media_headers(self) -> Dict:
        """媒体请求头：平台 Referer（防盗链）+ UA。

        B 站清晰度由 playurl 接口依据 Cookie 决定，返回的直链里已固化流版本，
        且带 deadline/upsig 签名，下载本身不需要 Cookie（已实测无 Cookie 可直接取流），
        因此不透传 Cookie，避免把账号凭证扩散到 CDN 域名。
        """
        headers = {"Referer": "https://www.bilibili.com/"}
        client_headers = getattr(self.bili_client, "headers", {}) or {}
        if client_headers.get("User-Agent"):
            headers["User-Agent"] = client_headers["User-Agent"]
        return headers

    async def get_all_creator_details(self, creator_url_list: List[str]):
        """
        creator_url_list: get details for creator from creator URL list
        """
        utils.logger.info(f"[BilibiliCrawler.get_all_creator_details] Crawling the details of creators")
        utils.logger.info(f"[BilibiliCrawler.get_all_creator_details] Parsing creator URLs...")

        creator_id_list = []
        for creator_url in creator_url_list:
            try:
                creator_info = parse_creator_info_from_url(creator_url)
                creator_id_list.append(int(creator_info.creator_id))
                utils.logger.info(f"[BilibiliCrawler.get_all_creator_details] Parsed creator ID: {creator_info.creator_id} from {creator_url}")
            except ValueError as e:
                utils.logger.error(f"[BilibiliCrawler.get_all_creator_details] Failed to parse creator URL: {e}")
                continue

        utils.logger.info(f"[BilibiliCrawler.get_all_creator_details] creator ids:{creator_id_list}")

        semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY_NUM)
        task_list: List[Task] = []
        try:
            for creator_id in creator_id_list:
                task = asyncio.create_task(self.get_creator_details(creator_id, semaphore), name=str(creator_id))
                task_list.append(task)
        except Exception as e:
            utils.logger.warning(f"[BilibiliCrawler.get_all_creator_details] error in the task list. The creator will not be included. {e}")

        await asyncio.gather(*task_list)

    async def get_creator_details(self, creator_id: int, semaphore: asyncio.Semaphore):
        """
        get details for creator id
        :param creator_id:
        :param semaphore:
        :return:
        """
        async with semaphore:
            creator_unhandled_info: Dict = await self.bili_client.get_creator_info(creator_id)
            # 主页公开统计（昵称/签名 + 关注/粉丝），供报告"粉丝量"一列使用。
            try:
                stat = await self.bili_client.get_creator_stat(creator_id)
            except Exception as e:  # noqa: BLE001 - 统计是旁路能力，失败不影响动态抓取
                utils.logger.warning(f"[BilibiliCrawler.get_creator_details] get stat failed for {creator_id}: {e}")
                stat = {}
            await bilibili_store.save_creator({
                "creator_hash": anonymize_user_id(creator_id),
                "user_id": str(creator_id),
                "nickname": mask_nickname(creator_unhandled_info.get("name")),
                "desc": creator_unhandled_info.get("sign", ""),
                "fans": stat.get("follower", ""),
                "follows": stat.get("following", ""),
                "home_url": f"https://space.bilibili.com/{creator_id}",
            })
            # 动态抓取仍需要 id/name（内存用），不依赖上面那条落盘
            creator_info: Dict = {
                "id": creator_id,
                "name": creator_unhandled_info.get("name"),
            }
        # 教学版：不再爬取粉丝/关注列表(其他用户的个人信息)，防骚扰。
        # await self.get_fans(creator_info, semaphore)
        # await self.get_followings(creator_info, semaphore)
        if config.PROFILE_ONLY:
            # 只要主页资料（昵称/粉丝数等），不继续抓该 UP 的动态 —— config/base_config.py:PROFILE_ONLY
            utils.logger.info("[BilibiliCrawler.get_creator_details] profile-only，跳过动态抓取")
            return
        await self.get_dynamics(creator_info, semaphore)

    async def get_fans(self, creator_info: Dict, semaphore: asyncio.Semaphore):
        """
        get fans for creator id
        :param creator_info:
        :param semaphore:
        :return:
        """
        creator_id = creator_info["id"]
        async with semaphore:
            try:
                utils.logger.info(f"[BilibiliCrawler.get_fans] begin get creator_id: {creator_id} fans ...")
                await self.bili_client.get_creator_all_fans(
                    creator_info=creator_info,
                    crawl_interval=config.CRAWLER_MAX_SLEEP_SEC,
                    callback=bilibili_store.batch_update_bilibili_creator_fans,
                    max_count=config.CRAWLER_MAX_CONTACTS_COUNT_SINGLENOTES,
                )

            except DataFetchError as ex:
                utils.logger.error(f"[BilibiliCrawler.get_fans] get creator_id: {creator_id} fans error: {ex}")
            except Exception as e:
                utils.logger.error(f"[BilibiliCrawler.get_fans] may be been blocked, err:{e}")

    async def get_followings(self, creator_info: Dict, semaphore: asyncio.Semaphore):
        """
        get followings for creator id
        :param creator_info:
        :param semaphore:
        :return:
        """
        creator_id = creator_info["id"]
        async with semaphore:
            try:
                utils.logger.info(f"[BilibiliCrawler.get_followings] begin get creator_id: {creator_id} followings ...")
                await self.bili_client.get_creator_all_followings(
                    creator_info=creator_info,
                    crawl_interval=config.CRAWLER_MAX_SLEEP_SEC,
                    callback=bilibili_store.batch_update_bilibili_creator_followings,
                    max_count=config.CRAWLER_MAX_CONTACTS_COUNT_SINGLENOTES,
                )

            except DataFetchError as ex:
                utils.logger.error(f"[BilibiliCrawler.get_followings] get creator_id: {creator_id} followings error: {ex}")
            except Exception as e:
                utils.logger.error(f"[BilibiliCrawler.get_followings] may be been blocked, err:{e}")

    async def get_dynamics(self, creator_info: Dict, semaphore: asyncio.Semaphore):
        """
        get dynamics for creator id
        :param creator_info:
        :param semaphore:
        :return:
        """
        creator_id = creator_info["id"]
        async with semaphore:
            try:
                utils.logger.info(f"[BilibiliCrawler.get_dynamics] begin get creator_id: {creator_id} dynamics ...")
                await self.bili_client.get_creator_all_dynamics(
                    creator_info=creator_info,
                    crawl_interval=config.CRAWLER_MAX_SLEEP_SEC,
                    callback=bilibili_store.batch_update_bilibili_creator_dynamics,
                    max_count=config.CRAWLER_MAX_DYNAMICS_COUNT_SINGLENOTES,
                )

            except DataFetchError as ex:
                utils.logger.error(f"[BilibiliCrawler.get_dynamics] get creator_id: {creator_id} dynamics error: {ex}")
            except Exception as e:
                utils.logger.error(f"[BilibiliCrawler.get_dynamics] may be been blocked, err:{e}")
