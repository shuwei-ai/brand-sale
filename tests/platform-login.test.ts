/**
 * 服务端扫码登录的**契约边界**（纯函数部分）。
 *
 * 真正起浏览器的那段没法在这里测（要网络、要 chromium），但最容易出错的地方恰恰
 * 不是浏览器，而是两处**翻译**：
 *   1. Python 的 stdout 行 → 会话事件。放宽一个字符，浏览器噪音就会被当成事件，
 *      症状是会话永远停在 starting（前端无限转圈）。
 *   2. 探测结果 → 每个平台一行。漏一个平台，前端就少一张卡片，用户以为平台不存在。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { markPlatformBound, mergeStatuses, parseLoginEvent, type PlatformStatus } from "../apps/collector/src/login-session.ts";

test("parseLoginEvent：正常二维码事件被解析", () => {
  const ev = parseLoginEvent('{"event":"qr","platform":"xhs","dataUrl":"data:image/png;base64,AAA","expiresIn":120}');
  assert.equal(ev?.event, "qr");
  assert.equal(ev?.platform, "xhs");
  assert.equal(ev?.dataUrl, "data:image/png;base64,AAA");
});

test("parseLoginEvent：人类日志行一律丢弃", () => {
  assert.equal(parseLoginEvent("[login] 浏览器启动成功：system-chrome"), null);
  assert.equal(parseLoginEvent(""), null);
  assert.equal(parseLoginEvent("   "), null);
});

test("parseLoginEvent：JSON 但没有 event 字段不算事件", () => {
  // 浏览器/内核也可能打印 JSON 日志，缺 event 的一律不认
  assert.equal(parseLoginEvent('{"level":"info","msg":"launch"}'), null);
  assert.equal(parseLoginEvent('{"event":123}'), null);
  assert.equal(parseLoginEvent('{"event":'), null);
});

test("parseLoginEvent：前后带空格的行仍可解析（stdout 分块常见）", () => {
  const ev = parseLoginEvent('  {"event":"logged_in","platform":"bili"}  ');
  assert.equal(ev?.event, "logged_in");
});

test("mergeStatuses：缺失的平台补成 error，而不是从列表里消失", () => {
  const got: PlatformStatus[] = [
    { platform: "xhs", name: "小红书", state: "bound", confidence: "verified" },
  ];
  const out = mergeStatuses(["xhs", "bili"], got);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.state, "bound");
  assert.equal(out[1]?.platform, "bili");
  assert.equal(out[1]?.state, "error");
  assert.match(out[1]?.detail ?? "", /没有返回结果/);
});

test("mergeStatuses：保留子进程给出的 unverified 语义（不能降级成 unbound）", () => {
  const out = mergeStatuses(
    ["dy"],
    [{ platform: "dy", name: "抖音", state: "unverified", confidence: "cookie" }],
  );
  assert.equal(out[0]?.state, "unverified");
  assert.equal(out[0]?.confidence, "cookie");
});

test("mergeStatuses：未指定平台时按平台表的全量顺序补齐", () => {
  const out = mergeStatuses([], []);
  assert.ok(out.length >= 7);
  assert.deepEqual(
    out.map((x) => x.platform),
    ["xhs", "dy", "ks", "bili", "wb", "tieba", "zhihu"],
  );
});

/**
 * 回归：扫码成功后列表还显示「未绑定」、计数停在 0/7（真机截图复现过）。
 *
 * 病根不是浏览器，而是**快照没人更新**：`snapshot` 只在 `check()` 里写，扫码会话进了
 * `succeeded` 也不改它，前端 `load()` 拉到的仍是上一次探测的旧结论。
 */
test("markPlatformBound：旧结论是 unbound，扫码成功后必须翻成 bound", () => {
  const before: PlatformStatus[] = [
    { platform: "xhs", name: "小红书", state: "unbound", confidence: "cookie", detail: "页面判定：未登录" },
    { platform: "dy", name: "抖音", state: "unbound", confidence: "cookie", detail: "profile 里没有该平台的登录 cookie" },
  ];
  const out = markPlatformBound(before, "dy", "已通过扫码授权，登录态写入 profile");
  assert.equal(out.length, 2);
  assert.equal(out[1]?.state, "bound");
  assert.equal(out[1]?.confidence, "verified");
  assert.match(out[1]?.detail ?? "", /扫码授权/);
  // 其它平台不能被顺带改动
  assert.equal(out[0]?.state, "unbound");
  assert.equal(before[1]?.state, "unbound", "纯函数：不能就地改入参");
});

test("markPlatformBound：快照里没有该平台时追加，位置不变", () => {
  const out = markPlatformBound([], "bili", "探活确认登录态有效");
  assert.deepEqual(out.map((x) => x.platform), ["bili"]);
  assert.equal(out[0]?.name, "B站");
  assert.equal(out[0]?.state, "bound");
});

test("markPlatformBound：重复确认只覆盖同一行，不产生重复条目", () => {
  const once = markPlatformBound([], "zhihu", "第一次");
  const twice = markPlatformBound(once, "zhihu", "第二次");
  assert.equal(twice.length, 1);
  assert.equal(twice[0]?.detail, "第二次");
});
