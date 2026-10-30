# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# This file is part of MediaCrawler project.
# Repository: https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/tieba/login.py
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


import asyncio
import functools
from typing import Optional

from playwright.async_api import BrowserContext, Page
from tenacity import (RetryError, retry, retry_if_result, stop_after_attempt,
                      wait_fixed)

import config
from base.base_crawler import AbstractLogin
from tools import utils


class BaiduTieBaLogin(AbstractLogin):

    def __init__(self,
                 login_type: str,
                 browser_context: BrowserContext,
                 context_page: Page,
                 login_phone: Optional[str] = "",
                 cookie_str: str = ""
                 ):
        config.LOGIN_TYPE = login_type
        self.browser_context = browser_context
        self.context_page = context_page
        self.login_phone = login_phone
        self.cookie_str = cookie_str

    @retry(stop=stop_after_attempt(600), wait=wait_fixed(1), retry=retry_if_result(lambda value: value is False))
    async def check_login_state(self) -> bool:
        """
        Poll to check if login status is successful, return True if successful, otherwise return False

        Returns:

        """
        current_cookie = await self.browser_context.cookies()
        _, cookie_dict = utils.convert_cookies(current_cookie)
        stoken = cookie_dict.get("STOKEN")
        ptoken = cookie_dict.get("PTOKEN")
        if stoken or ptoken:
            return True
        return False

    async def begin(self):
        """Start login baidutieba"""
        utils.logger.info("[BaiduTieBaLogin.begin] Begin login baidutieba ...")
        if config.LOGIN_TYPE == "qrcode":
            await self.login_by_qrcode()
        elif config.LOGIN_TYPE == "phone":
            await self.login_by_mobile()
        elif config.LOGIN_TYPE == "cookie":
            await self.login_by_cookies()
        elif config.LOGIN_TYPE == "none":
            raise ValueError(
                "[BaiduTieBaLogin.begin] 登录态失效（login=none）：请到前端「平台绑定」页为贴吧重新扫码，采集内核不自行登录")
        else:
            raise ValueError("[BaiduTieBaLogin.begin]Invalid Login Type Currently only supported qrcode or phone or cookies ...")

    async def login_by_mobile(self):
        """Login baidutieba by mobile"""
        pass

    async def login_by_qrcode(self):
        """login baidutieba website and keep webdriver login state

        2026-10 真机修正：贴吧首页**不会**自动弹登录二维码，而登录入口的选择器已随改版变化
        （老的 `li.u_login` 不存在了，现在是带「登录」文字的 `div.login-btn`）。上游在这里
        的行为是：找不到码 → 点 `li.u_login`（Timeout 30s）→ `sys.exit()`，整条链路硬失败。
        现改为：短超时探测 → 依次试新旧登录入口 → 都没有则**提示手动登录并继续等登录态**，
        不再因为选择器过期而退出。
        """
        utils.logger.info("[BaiduTieBaLogin.login_by_qrcode] Begin login baidutieba by qrcode ...")
        qrcode_img_selector = "xpath=//img[@class='tang-pass-qrcode-img']"
        # 首页通常不自动弹码，先用 5s 短超时确认有没有（老布局才可能有），别在"确认没有"上耗 30s
        base64_qrcode_img = await utils.find_login_qrcode(
            self.context_page, selector=qrcode_img_selector, timeout_ms=5000
        )
        if not base64_qrcode_img:
            # 手动点开登录入口。新旧两种布局都试，命中即停
            for entry in ("xpath=//div[contains(@class,'login-btn')]", "xpath=//li[@class='u_login']"):
                try:
                    await self.context_page.locator(entry).first.click(timeout=5000)
                    break
                except Exception:
                    continue
            # 弹窗里的 <img> 先给一个 loading.gif 占位、再把 src 换成真码 —— 直接取会拿到
            # loading 图（真机踩过）。等 src 变成真正的二维码接口再取。
            try:
                await self.context_page.wait_for_function(
                    "() => { const i = document.querySelector('img.tang-pass-qrcode-img');"
                    " return !!i && /passport\\.baidu\\.com\\/v2\\/api\\/qrcode/.test(i.src || ''); }",
                    timeout=15000,
                )
            except Exception:
                pass  # 等不到就照旧走 find_login_qrcode，由它超时后走"手动登录"分支
            # 弹窗加载 + 二维码刷新需要点时间，这里放宽到 15s
            base64_qrcode_img = await utils.find_login_qrcode(
                self.context_page, selector=qrcode_img_selector, timeout_ms=15000
            )

        if base64_qrcode_img:
            # show login qrcode
            # fix issue #12
            # we need to use partial function to call show_qrcode function and run in executor
            # then current asyncio event loop will not be blocked
            partial_show_qrcode = functools.partial(utils.show_qrcode, base64_qrcode_img)
            asyncio.get_running_loop().run_in_executor(executor=None, func=partial_show_qrcode)
        else:
            utils.logger.warning(
                "[BaiduTieBaLogin.login_by_qrcode] 未找到内嵌登录二维码（页面可能又改版，或被安全验证拦截）。"
                "请在已弹出的浏览器窗口里手动完成登录（扫码或账号密码均可），内核会继续轮询登录态，最长 600 秒。"
            )

        utils.logger.info(f"[BaiduTieBaLogin.login_by_qrcode] waiting for scan code login, remaining time is 600s")
        try:
            await self.check_login_state()
        except RetryError:
            # 上游这里是 sys.exit()：SystemExit 不被任何 except Exception 捕获，进程直接死、
            # 日志里只剩一坨 traceback。改成带原因的异常，让上层错误信息能说清"是登录没完成"。
            raise RuntimeError(
                "贴吧登录未完成：等待 600 秒仍未检测到登录态（STOKEN/PTOKEN）。"
                "请在浏览器窗口内完成登录后重试；若窗口被安全验证拦截，请先手动通过验证。"
            )

        wait_redirect_seconds = 5
        utils.logger.info(f"[BaiduTieBaLogin.login_by_qrcode] Login successful then wait for {wait_redirect_seconds} seconds redirect ...")
        await asyncio.sleep(wait_redirect_seconds)

    async def login_by_cookies(self):
        """login baidutieba website by cookies"""
        utils.logger.info("[BaiduTieBaLogin.login_by_cookies] Begin login baidutieba by cookie ...")
        for key, value in utils.convert_str_cookie_to_dict(self.cookie_str).items():
            await self.browser_context.add_cookies([{
                'name': key,
                'value': value,
                'domain': ".baidu.com",
                'path': "/"
            }])
