# -*- coding: utf-8 -*-
# Copyright (c) 2025 relakkes@gmail.com
#
# 本文件为 MediaCrawler 教学版的一部分，brandsale 对其做了业务化改造：
#   上游教学版出于"防骚扰"定位，把昵称做**中间脱敏**（`张***三`）后再落盘。
#   但 brandsale 的报告必须让读者能据账号名去平台核对/检索 —— 一个 `长***菜`
#   既搜不到、也看不出是谁，会被读成"数据是编的"。业主因此明确要求：
#   **人选/账号不要隐藏 `****`，完整显示**。
# 现在默认**完整保留昵称**；如确需恢复脱敏，启动采集时设
# `BM_MC_MASK_NICKNAME=true`（或 1/yes/on）即可退回旧行为。
# 说明：原始用户 ID 依旧只落 `creator_hash`（不落原始 uid）——它只做分组键，
# 不参与账号展示，故保留匿名化。
import hashlib
import os


def _mask_enabled() -> bool:
    """是否对昵称脱敏。默认关（完整显示）；仅显式开启时才打码。"""
    return os.environ.get("BM_MC_MASK_NICKNAME", "").strip().lower() in {"1", "true", "yes", "on"}


def anonymize_user_id(user_id) -> str:
    """把原始用户 ID 转成匿名哈希，用于内容/评论记录的创作者分组，
    不暴露真实身份。返回 sha256 截断 16 位的十六进制串。"""
    if user_id is None:
        return ""
    s = str(user_id).strip()
    if not s:
        return ""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def mask_nickname(name) -> str:
    """账号昵称。

    默认**完整返回**，不做任何打码 —— 报告里的人选/账号需要能被完整看到并检索。
    仅当显式设置 `BM_MC_MASK_NICKNAME=true` 时，才退回旧的中间脱敏：
    - 长度 <= 1：返回 "*"
    - 长度 == 2：首字 + "*"
    - 长度 >= 3：首字 + "***" + 尾字
    """
    if name is None:
        return ""
    s = str(name)
    if not _mask_enabled():
        return s
    if len(s) <= 1:
        return "*"
    if len(s) == 2:
        return s[0] + "*"
    return s[0] + "***" + s[-1]
