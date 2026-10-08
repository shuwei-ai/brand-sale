/**
 * M1 附：轻量 Web 控制台（单页、零构建依赖）
 *
 * 设计取舍：
 *   - 不做框架、不做打包：整页就是一个内联 CSS/JS 的 HTML 字符串，由网关在 `/` 直接吐出。
 *     交付面上少一个 node_modules，私有化离线部署时也没有构建步骤。
 *   - 页面本身**不需要鉴权**（只是一张静态表单），但页内所有 API 调用都带
 *     `Authorization: Bearer t.<tenantId>.<userId>`，token 由页面顶部输入框提供。
 *   - SSE 用 fetch + ReadableStream 手写解析，而不是 EventSource：
 *     EventSource 不能自定义请求头，用它就必须把 token 塞进 URL（会进日志/Referer），
 *     所以这儿宁可多写几十行解析，也不弱化鉴权边界。
 *   - 报告预览同样先 fetch 成 blob 再喂 iframe：`GET /jobs/:id/report` 要鉴权，
 *     iframe 的 src 带不了请求头，blob URL 才能在不开后门的前提下内嵌预览。
 */

import { API_PREFIX, PHASE_LABEL, PHASE_ORDER } from "@brandsale/contracts";
import type { Config } from "@brandsale/config";

export interface ConsoleContext {
  config: Config;
  mocked: boolean;
}

export function consoleHtml({ config, mocked }: ConsoleContext): string {
  const bootstrap = JSON.stringify({
    apiPrefix: API_PREFIX,
    phases: PHASE_ORDER.map((p) => ({ name: p, label: PHASE_LABEL[p] })),
    env: config.env,
    mode: mocked ? "mock" : "live",
    endpoint: config.llm.baseUrl,
    model: config.llm.models.medium,
    defaultToken: "t.tenant_demo.u_demo",
    allowPartial: config.job.allowPartial,
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>brandsale · 品牌营销策略咨询控制台</title>
<style>
  /* ── 设计系统 ─────────────────────────────────────────── */
  :root {
    --bg: #f4f5fa; --panel: #fff;
    --ink: #191d27; --ink-2: #4b5364; --ink-3: #8a92a6;
    --line: #e7eaf1; --line-2: #d9ddeb;
    --brand: #4f46e5; --brand-2: #7c3aed;
    --brand-grad: linear-gradient(135deg, #4f46e5, #7c3aed);
    --brand-soft: #eef0fe; --brand-ring: rgba(79, 70, 229, .15);
    --ok: #0e8a4d; --ok-soft: #e5f6ec;
    --warn: #b25e00; --warn-soft: #fdf3e1;
    --err: #c62828; --err-soft: #fdecec;
    --radius: 14px; --radius-s: 10px;
    --shadow-s: 0 1px 2px rgba(25,29,39,.04), 0 2px 6px rgba(25,29,39,.05);
    --shadow-m: 0 4px 14px rgba(25,29,39,.07), 0 18px 44px rgba(25,29,39,.10);
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { scrollbar-gutter: stable; }
  body { margin: 0; color: var(--ink);
    background: radial-gradient(1100px 420px at 18% -120px, #e7e9fd 0%, rgba(231,233,253,0) 62%), var(--bg);
    font: 13.5px/1.65 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }

  /* 滚动条 */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #c9cdda; border-radius: 99px; }
  ::-webkit-scrollbar-thumb:hover { background: #aeb4c7; }

  /* 顶栏：玻璃拟态 */
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 12px 22px; position: sticky; top: 0; z-index: 20;
    background: rgba(255,255,255,.85); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid rgba(231,234,241,.95); }
  .logo { width: 32px; height: 32px; border-radius: 10px; background: var(--brand-grad); color: #fff;
    font-weight: 800; font-size: 16px; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 10px rgba(79,70,229,.35); flex: 0 0 auto; }
  .brand { display: flex; flex-direction: column; line-height: 1.35; }
  header h1 { font-size: 15px; margin: 0; font-weight: 750; letter-spacing: .2px; }
  header .sub { color: var(--ink-3); font-size: 11.5px; }
  .spacer { flex: 1; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px;
    border-radius: 999px; font-size: 12px; background: var(--brand-soft); color: var(--brand); font-weight: 550; }
  .chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .chip.ok { background: var(--ok-soft); color: var(--ok); }
  .chip.err { background: var(--err-soft); color: var(--err); }
  .chip.dim { background: #eceef4; color: var(--ink-2); }

  /* 表单控件 */
  input, select, textarea, button { font: inherit; color: inherit; }
  input[type=text], input[type=date], input[type=number], textarea, select {
    width: 100%; padding: 7px 10px; border: 1px solid var(--line-2); border-radius: var(--radius-s);
    background: #fff; outline: none; font-size: 13px; color: var(--ink);
    transition: border-color .15s ease, box-shadow .15s ease; }
  input[type=text]:hover, input[type=date]:hover, input[type=number]:hover, textarea:hover, select:hover { border-color: #c3c8da; }
  input:focus, textarea:focus, select:focus { border-color: var(--brand); box-shadow: 0 0 0 3.5px var(--brand-ring); }
  button { padding: 7px 14px; border-radius: var(--radius-s); border: 1px solid var(--line-2); background: #fff;
    cursor: pointer; font-size: 13px; font-weight: 550; color: var(--ink-2);
    transition: all .15s ease; }
  button:hover { border-color: #b9bfd2; background: #fafbfe; color: var(--ink); box-shadow: var(--shadow-s); }
  button:active { transform: translateY(1px); }
  button.primary { background: var(--brand-grad); border: 1px solid transparent; color: #fff; font-weight: 650;
    box-shadow: 0 2px 10px rgba(79,70,229,.32); }
  button.primary:hover { background: var(--brand-grad); border-color: transparent; color: #fff;
    filter: brightness(1.07); box-shadow: 0 5px 18px rgba(79,70,229,.42); transform: translateY(-1px); }
  button.primary:active { transform: translateY(0); filter: brightness(.98); }
  button.danger:hover { border-color: var(--err); color: var(--err); background: var(--err-soft); }
  button:disabled { opacity: .45; cursor: not-allowed; transform: none !important; }

  /* 布局与卡片 */
  main { display: grid; grid-template-columns: 360px 1fr; gap: 18px; padding: 18px 22px 44px; align-items: start; }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 18px; margin-bottom: 18px; box-shadow: var(--shadow-s); }
  .card h2 { font-size: 13px; margin: 0 0 12px; color: var(--ink); font-weight: 700;
    display: flex; align-items: center; gap: 8px; letter-spacing: .3px; }
  .card h2::before { content: ""; width: 3px; height: 13px; border-radius: 2px; background: var(--brand-grad); }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 4px; font-weight: 550; }
  .sec { font-size: 11px; font-weight: 700; color: var(--ink-3); letter-spacing: 1.2px;
    margin: 16px 0 9px; padding-bottom: 7px; border-bottom: 1px dashed var(--line);
    display: flex; align-items: center; justify-content: space-between; }
  .sec:first-of-type { margin-top: 2px; }
  .sec .sec-note { font-weight: 500; letter-spacing: 0; }
  .hint { font-size: 11.5px; color: var(--ink-3); margin-top: 8px; }

  /* 平台多选：胶囊开关 */
  .platforms { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
  .platforms .pchip { position: relative; display: inline-flex; align-items: center; cursor: pointer;
    padding: 5px 13px; border-radius: 999px; border: 1px solid var(--line-2); background: #fff;
    font-size: 12.5px; color: var(--ink-2); user-select: none; transition: all .15s ease; }
  .platforms .pchip::before { content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: #c3c8da; margin-right: 6px; transition: all .15s ease; }
  .platforms .pchip:hover { border-color: #b9bfd2; }
  .platforms .pchip input { position: absolute; opacity: 0; pointer-events: none; }
  .platforms .pchip input:checked + span { color: var(--brand); font-weight: 600; }
  .platforms .pchip:has(input:checked) { border-color: var(--brand); background: var(--brand-soft); }
  .platforms .pchip:has(input:checked)::before { background: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }

  /* 任务列表 */
  .job-item { padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-s);
    margin-bottom: 8px; cursor: pointer; position: relative; background: #fff;
    transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease; }
  .job-item:hover { border-color: var(--brand); transform: translateX(2px); box-shadow: var(--shadow-s); }
  .job-item.active { border-color: var(--brand); background: var(--brand-soft); }
  .job-item.active::before { content: ""; position: absolute; left: -1px; top: 9px; bottom: 9px;
    width: 3px; border-radius: 3px; background: var(--brand-grad); }
  .job-item .id { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); }
  .job-item .meta { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 12px; color: var(--ink-3); }

  .badge { padding: 2px 9px; border-radius: 999px; font-size: 11.5px; background: #eceef4; color: var(--ink-2);
    white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; font-weight: 550; }
  .badge::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
  .badge.running::before, .badge.queued::before { animation: blink 1.2s ease-in-out infinite; }
  @keyframes blink { 50% { opacity: .25; } }
  .badge.running, .badge.queued { background: var(--brand-soft); color: var(--brand); }
  .badge.succeeded { background: var(--ok-soft); color: var(--ok); }
  .badge.partial { background: var(--warn-soft); color: var(--warn); }
  .badge.failed, .badge.cancelled { background: var(--err-soft); color: var(--err); }

  /* 进度与阶段 */
  .bar { height: 8px; background: #eceef5; border-radius: 999px; overflow: hidden; margin: 10px 0;
    box-shadow: inset 0 1px 2px rgba(25,29,39,.07); }
  .bar > i { display: block; height: 100%; background: var(--brand-grad); width: 0;
    transition: width .4s ease; border-radius: 999px; }
  .phases { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
  @media (max-width: 1180px) { .phases { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .phase { border: 1px solid var(--line); border-radius: var(--radius-s); padding: 10px 11px;
    background: #fbfcfe; min-height: 80px; position: relative; overflow: hidden;
    transition: border-color .2s ease, background .2s ease; }
  .phase::after { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: transparent; }
  .phase.running { border-color: var(--brand); background: var(--brand-soft); }
  .phase.running::after { background: var(--brand-grad); }
  .phase.succeeded { border-color: #bfe3cf; background: var(--ok-soft); }
  .phase.succeeded::after { background: var(--ok); }
  .phase.partial { border-color: #f0d9a8; background: var(--warn-soft); }
  .phase.partial::after { background: var(--warn); }
  .phase.failed { border-color: #f2c0c0; background: var(--err-soft); }
  .phase.failed::after { background: var(--err); }
  .phase .ph-head { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
  .phase .ph-idx { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px;
    border-radius: 7px; background: #eceef4; color: var(--ink-3); font-size: 10.5px; font-weight: 700;
    font-family: var(--mono); flex: 0 0 auto; }
  .phase.running .ph-idx { background: var(--brand-grad); color: #fff; }
  .phase.succeeded .ph-idx { background: var(--ok-soft); color: var(--ok); }
  .phase.partial .ph-idx { background: var(--warn-soft); color: var(--warn); }
  .phase.failed .ph-idx { background: var(--err-soft); color: var(--err); }
  .phase .name { font-size: 12px; font-weight: 650; }
  .phase .state { font-size: 11px; color: var(--ink-3); margin-top: 2px;
    font-variant-numeric: tabular-nums; }

  /* Tabs：分段控件 */
  .tabs { display: inline-flex; gap: 2px; margin-bottom: 14px; padding: 3px;
    background: #eceef4; border-radius: 12px; }
  .tabs button { border: none; background: transparent; padding: 6px 16px; border-radius: 9px;
    color: var(--ink-2); font-size: 13px; box-shadow: none; }
  .tabs button:hover { color: var(--ink); background: rgba(255,255,255,.65); box-shadow: none; }
  .tabs button.on { background: #fff; color: var(--ink); font-weight: 650; box-shadow: var(--shadow-s); }
  .panel { display: none; }
  .panel.on { display: block; }

  /* 事件流：终端外壳 */
  .terminal { border-radius: var(--radius-s); overflow: hidden; border: 1px solid #242b37; background: #0f1319;
    box-shadow: var(--shadow-s); }
  .term-bar { display: flex; align-items: center; gap: 6px; padding: 8px 13px; background: #161c25;
    border-bottom: 1px solid #242b37; }
  .term-bar i { width: 10px; height: 10px; border-radius: 50%; }
  .term-bar i:nth-child(1) { background: #ff5f57; }
  .term-bar i:nth-child(2) { background: #febc2e; }
  .term-bar i:nth-child(3) { background: #28c840; }
  .term-bar span { margin-left: 8px; font-size: 11px; color: #66768a; font-family: var(--mono); letter-spacing: .5px; }
  #events { background: #0f1319; color: #ccd6e2; border-radius: 0; padding: 11px 13px;
    height: 300px; overflow: auto; font-family: var(--mono); font-size: 12px; line-height: 1.75; }
  #events::-webkit-scrollbar-thumb { background: #2c3442; }
  #events::-webkit-scrollbar-thumb:hover { background: #3a4454; }
  #events .row { display: flex; gap: 8px; }
  #events .t { color: #5b6a7d; flex: 0 0 62px; font-variant-numeric: tabular-nums; }
  #events .k { flex: 0 0 132px; color: #7fb2ff; }
  #events .v { color: #c8d9cc; word-break: break-all; }
  #events .row.err .k { color: #ff8f8f; }
  #events .row.warn .k { color: #ffcc7a; }
  #events .row.ok .k { color: #86e0a6; }

  /* 流式回显：固定在视口内的一整块可滚动区域，单条消息不再截断高度 */
  #live { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;
    height: clamp(260px, 56vh, 720px); overflow-y: auto; overflow-x: hidden;
    padding: 2px 6px 2px 2px; border-radius: var(--radius-s); background: #fbfcfe; border: 1px solid var(--line); }
  .live-item { flex: 0 0 auto; background: #fff; border: 1px solid var(--line); border-radius: var(--radius-s);
    padding: 8px 11px; box-shadow: var(--shadow-s); }
  .live-item .who { font-size: 10.5px; color: var(--brand); font-weight: 700; margin-bottom: 3px;
    font-family: var(--mono); letter-spacing: .6px;
    position: sticky; top: -8px; background: #fff; padding: 2px 0; }
  .live-item .txt { font-size: 12px; color: var(--ink-2);
    white-space: pre-wrap; word-break: break-all; }
  #report { width: 100%; height: 620px; border: 1px solid var(--line); border-radius: var(--radius-s);
    background: #fff; display: block; box-shadow: var(--shadow-s); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--line); }
  th { color: var(--ink-3); font-weight: 650; background: #fafbfe; font-size: 11px;
    letter-spacing: .6px; text-transform: uppercase; }
  tbody tr { transition: background .12s ease; }
  tbody tr:hover td { background: #f8f9fd; }
  .kv { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--ink-2); align-items: center;
    font-variant-numeric: tabular-nums; }
  .kv b { color: var(--ink); font-weight: 650; }
  .degraded { background: var(--warn-soft); border: 1px solid #f0d9a8; color: #7a4a00;
    border-radius: var(--radius-s); padding: 9px 12px; font-size: 12px; margin-top: 12px; white-space: pre-wrap; }
  .empty { color: var(--ink-3); font-size: 12.5px; padding: 12px 0; }
  .row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
</style>
</head>
<body>
<header>
  <div class="logo" aria-hidden="true">B</div>
  <div class="brand">
    <h1>brandsale 控制台</h1>
    <span class="sub">品牌营销 AI 策略咨询 · 六阶段流水线</span>
  </div>
  <span id="health" class="chip dim">正在探测端点…</span>
  <span class="spacer"></span>
  <label class="sub" for="token">Token</label>
  <input id="token" type="text" style="width:210px" autocomplete="off">
  <button id="btn-save-token">保存</button>
</header>

<main>
  <div>
    <div class="card">
      <h2>新建任务（Brief）</h2>
      <div class="sec">基本信息</div>
      <div class="grid-2">
        <div class="field"><label>行业</label><input id="f-industry" type="text" value="美妆"></div>
        <div class="field"><label>类目</label><input id="f-category" type="text" value="护肤品-精华"></div>
      </div>
      <div class="field"><label>品牌 ID（逗号分隔）</label><input id="f-brands" type="text" value="brand_A"></div>
      <div class="sec">投放设置</div>
      <div class="grid-2">
        <div class="field"><label>预算（万元）</label><input id="f-budget" type="number" value="300" min="1" step="10"></div>
        <div class="field"><label>平台（可多选）</label>
          <div class="platforms" id="f-platforms">
            <label class="pchip"><input type="checkbox" value="douyin" checked><span>抖音</span></label>
            <label class="pchip"><input type="checkbox" value="xiaohongshu" checked><span>小红书</span></label>
            <label class="pchip"><input type="checkbox" value="bilibili"><span>B 站</span></label>
            <label class="pchip"><input type="checkbox" value="weibo"><span>微博</span></label>
          </div>
        </div>
      </div>
      <div class="sec">目标权重<span class="sec-note">合计 = 1</span></div>
      <div class="grid-3">
        <div class="field"><label>认知</label><input id="f-wa" type="number" value="0.3" step="0.05" min="0" max="1"></div>
        <div class="field"><label>转化</label><input id="f-wc" type="number" value="0.5" step="0.05" min="0" max="1"></div>
        <div class="field"><label>留存</label><input id="f-wr" type="number" value="0.2" step="0.05" min="0" max="1"></div>
      </div>
      <div class="sec">时间窗口</div>
      <div class="grid-2">
        <div class="field"><label>窗口起</label><input id="f-from" type="date" value="2026-05-20"></div>
        <div class="field"><label>窗口止</label><input id="f-to" type="date" value="2026-06-20"></div>
      </div>
      <div class="field"><label>补充说明</label><textarea id="f-notes" rows="2">主打新品抗老精华，竞品锁定 X/Y</textarea></div>
      <button id="btn-submit" class="primary" style="width:100%">提交并开始执行</button>
      <div class="hint" id="submit-hint">提交后自动建立 SSE 连接，实时观察六个阶段。</div>
    </div>

    <div class="card">
      <h2>任务列表</h2>
      <div id="job-list" class="empty">加载中…</div>
      <button id="btn-reload-jobs" style="width:100%">刷新列表</button>
    </div>
  </div>

  <div>
    <div class="card" id="job-card">
      <div class="empty">尚未选择任务。在左侧提交 Brief，或点击任务列表中的条目。</div>
    </div>

    <div class="card">
      <div class="tabs">
        <button data-tab="events" class="on">实时事件流</button>
        <button data-tab="report">报告预览</button>
        <button data-tab="artifacts">产物</button>
      </div>

      <div class="panel on" data-panel="events">
        <div id="live"></div>
        <div class="terminal">
          <div class="term-bar"><i></i><i></i><i></i><span>events · 实时事件流</span></div>
          <div id="events"></div>
        </div>
      </div>

      <div class="panel" data-panel="report">
        <div class="kv" style="margin-bottom:8px">
          <button id="btn-open-report" disabled>在新标签打开</button>
          <span id="report-note" class="sub"></span>
        </div>
        <div id="report-empty" class="empty">报告尚未产出。任务执行到「研报生成与渲染」阶段后会自动出现。</div>
        <iframe id="report" title="报告预览"></iframe>
      </div>

      <div class="panel" data-panel="artifacts">
        <div id="artifact-list" class="empty">选择任务后加载产物。</div>
      </div>
    </div>
  </div>
</main>

<script>
(function () {
  var CFG = ${bootstrap};
  var api = CFG.apiPrefix;
  var state = { jobId: null, stream: null, lastSeq: null, liveBuffers: {} };

  function token() { return document.getElementById('token').value.trim(); }
  function headers(extra) {
    var h = { Authorization: 'Bearer ' + token() };
    if (extra) { for (var k in extra) h[k] = extra[k]; }
    return h;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(m) { return m ? '¥' + Number(m.amount || 0).toFixed(4) : '¥0'; }
  function clock(iso) {
    var d = new Date(iso || Date.now());
    return isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8);
  }
  function shortId(id) { return id && id.length > 18 ? id.slice(0, 12) + '…' + id.slice(-4) : (id || ''); }
  function extOf(kind) { return kind === 'report_html' ? 'html' : kind === 'report_markdown' ? 'md' : 'json'; }

  function req(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: headers(opts.headers) };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (x) {}
        if (!r.ok || (j && j.error)) {
          throw new Error((j && j.error && (j.error.userMessage || j.error.message)) || ('HTTP ' + r.status));
        }
        return j;
      });
    });
  }

  function loadHealth() {
    var el = document.getElementById('health');
    fetch('/health').then(function (r) { return r.json(); }).then(function (h) {
      var llm = h.llm || {};
      el.title = (llm.mode || '') + ' · ' + (llm.baseUrl || '') + ' · env=' + (h.env || '');
      if (llm.mode === 'mock') { el.className = 'chip dim'; el.textContent = '离线桩模式（mock）'; return; }
      if (llm.ok) {
        el.className = 'chip ok';
        el.textContent = '端点可用 · ' + (llm.model || '') + ' · ' + ((llm.models || []).length) + ' 个模型';
      } else {
        el.className = 'chip err';
        el.textContent = '端点不可用：' + (llm.error || '未知错误');
      }
    }).catch(function (e) { el.className = 'chip err'; el.textContent = '健康检查失败：' + e.message; });
  }

  function loadJobs() {
    var box = document.getElementById('job-list');
    return req(api + '/jobs?limit=20').then(function (j) {
      var items = (j && j.items) || [];
      if (!items.length) { box.innerHTML = '<div class="empty">暂无任务</div>'; return; }
      box.innerHTML = items.map(function (it) {
        var brief = (it.spec && it.spec.brief) || {};
        var pct = Math.round(((it.progress && it.progress.percent) || 0) * 100);
        return '<div class="job-item' + (it.jobId === state.jobId ? ' active' : '') + '" data-id="' + esc(it.jobId) + '">' +
          '<div class="id">' + esc(shortId(it.jobId)) + '</div>' +
          '<div class="meta"><span class="badge ' + esc(it.status) + '">' + esc(it.status) + '</span>' +
          '<span>' + esc(brief.category || '') + '</span>' +
          '<span style="flex:1"></span><span>' + pct + '%</span></div></div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.job-item'), function (el) {
        el.addEventListener('click', function () { selectJob(el.getAttribute('data-id')); });
      });
    }).catch(function (e) { box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
  }

  function selectJob(jobId) {
    state.jobId = jobId;
    state.lastSeq = null;
    state.liveBuffers = {};
    document.getElementById('live').innerHTML = '';
    loadJobs(); loadDetail(); loadArtifacts(); loadReport(); connectStream(jobId);
  }

  function loadDetail() {
    if (!state.jobId) return Promise.resolve();
    var jobId = state.jobId;
    return Promise.all([
      req(api + '/jobs/' + encodeURIComponent(jobId)),
      req(api + '/jobs/' + encodeURIComponent(jobId) + '/phases'),
      req(api + '/jobs/' + encodeURIComponent(jobId) + '/usage')
    ]).then(function (rs) {
      if (state.jobId !== jobId) return;
      renderJob(rs[0].job, (rs[1] && rs[1].items) || [], rs[2]);
    }).catch(function (e) {
      document.getElementById('job-card').innerHTML = '<div class="empty">任务详情加载失败：' + esc(e.message) + '</div>';
    });
  }

  function renderJob(job, phases, usage) {
    var pct = Math.round(((job.progress && job.progress.percent) || 0) * 100);
    var byPhase = {};
    phases.forEach(function (p) { byPhase[p.phase] = p; });
    var cards = CFG.phases.map(function (p, i) {
      var st = byPhase[p.name] || { status: 'pending', attempts: 0, cost: { amount: 0 } };
      var extra = '';
      if (st.errorCode) extra += '<div class="state" style="color:#c62828">' + esc(st.errorCode) + '</div>';
      if (st.degraded && st.degraded.reason) extra += '<div class="state" title="' + esc(st.degraded.reason) + '">已降级</div>';
      return '<div class="phase ' + esc(st.status) + '">' +
        '<div class="ph-head"><span class="ph-idx">' + (i + 1) + '</span><span class="name">' + esc(p.label) + '</span></div>' +
        '<div class="state">' + esc(st.status) + ' · 尝试 ' + (st.attempts || 0) + ' 次</div>' +
        '<div class="state">' + money(st.cost) + '</div>' + extra + '</div>';
    }).join('');

    var degraded = (job.degraded || []).map(function (d) {
      return '· [' + d.reason + '] ' + (d.note || '') +
        (d.missing && d.missing.length ? '（' + d.missing.slice(0, 3).join(' | ') + '）' : '');
    }).join('\\n');

    var tk = (usage && usage.tokens) || {};
    document.getElementById('job-card').innerHTML =
      '<h2>任务 ' + esc(shortId(job.jobId)) + '</h2>' +
      '<div class="kv">' +
        '<span class="badge ' + esc(job.status) + '">' + esc(job.status) + '</span>' +
        '<span>进度 <b>' + pct + '%</b>' + (job.progress && job.progress.currentPhase ? ' · 当前 ' + esc(job.progress.currentPhase) : '') + '</span>' +
        '<span>成本 <b>' + money(usage && usage.cost) + '</b></span>' +
        '<span>模型调用 <b>' + (tk.calls || 0) + '</b> 次</span>' +
        '<span>tokens <b>' + (tk.inputTokens || 0) + '</b> 入 / <b>' + (tk.outputTokens || 0) + '</b> 出</span>' +
      '</div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="phases">' + cards + '</div>' +
      '<div class="row-actions">' +
        '<button id="btn-rerun">重跑 report 阶段</button>' +
        '<button id="btn-cancel" class="danger">取消任务</button>' +
        '<button id="btn-recover">崩溃恢复扫描</button>' +
      '</div>' +
      (degraded ? '<div class="degraded">降级与缺失：\\n' + esc(degraded) + '</div>' : '');

    document.getElementById('btn-rerun').addEventListener('click', function () { rerunPhase('report'); });
    document.getElementById('btn-cancel').addEventListener('click', cancelJob);
    document.getElementById('btn-recover').addEventListener('click', function () {
      req(api + '/recover', { method: 'POST' }).then(function (r) {
        appendEvent('ops.recover', JSON.stringify(r), 'warn');
        loadJobs(); loadDetail();
      }).catch(function (e) { appendEvent('error', e.message, 'err'); });
    });
  }

  function cancelJob() {
    if (!state.jobId) return;
    req(api + '/jobs/' + encodeURIComponent(state.jobId) + '/cancel', { method: 'POST', body: { reason: '控制台取消' } })
      .then(function () { appendEvent('job.cancel', '已请求取消', 'warn'); loadDetail(); })
      .catch(function (e) { appendEvent('error', e.message, 'err'); });
  }

  function rerunPhase(phase) {
    if (!state.jobId) return;
    req(api + '/jobs/' + encodeURIComponent(state.jobId) + '/rerun/' + phase, { method: 'POST', body: {} })
      .then(function () {
        appendEvent('phase.rerun', '已触发重跑：' + phase, 'warn');
        loadDetail(); connectStream(state.jobId);
      })
      .catch(function (e) { appendEvent('error', e.message, 'err'); });
  }

  function loadArtifacts() {
    if (!state.jobId) return;
    var box = document.getElementById('artifact-list');
    req(api + '/jobs/' + encodeURIComponent(state.jobId) + '/artifacts').then(function (j) {
      var items = (j && j.items) || [];
      if (!items.length) { box.innerHTML = '<div class="empty">尚无产物</div>'; return; }
      box.innerHTML = '<table><thead><tr><th>产物</th><th>生成时间</th><th></th></tr></thead><tbody>' +
        items.map(function (a) {
          return '<tr><td>' + esc(a.kind) + '</td><td>' + esc(clock(a.createdAt)) + '</td>' +
            '<td><button data-kind="' + esc(a.kind) + '" data-act="peek">预览</button> ' +
            '<button data-kind="' + esc(a.kind) + '" data-act="dl">下载</button></td></tr>';
        }).join('') + '</tbody></table>';
      Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
        b.addEventListener('click', function () {
          var kind = b.getAttribute('data-kind');
          if (b.getAttribute('data-act') === 'peek') previewArtifact(kind); else downloadArtifact(kind, b);
        });
      });
    }).catch(function (e) { box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
  }

  function artifactUrl(kind) {
    return api + '/jobs/' + encodeURIComponent(state.jobId) + '/artifacts/' + encodeURIComponent(kind);
  }

  function fetchArtifact(kind) {
    return fetch(artifactUrl(kind), { headers: headers() }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 160)); });
      return r.text();
    });
  }

  function downloadArtifact(kind, btn) {
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = '取回中…';
    fetchArtifact(kind).then(function (text) {
      var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url; a.download = kind + '-' + state.jobId + '.' + extOf(kind);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }).catch(function (e) { appendEvent('error', '下载失败：' + e.message, 'err'); })
      .then(function () { btn.disabled = false; btn.textContent = old; });
  }

  function previewArtifact(kind) {
    fetchArtifact(kind).then(function (text) {
      if (kind === 'report_html') { switchTab('report'); setReportBlob(text); return; }
      var pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (x) {}
      var url = URL.createObjectURL(new Blob([pretty], { type: 'text/plain;charset=utf-8' }));
      window.open(url, '_blank');
    }).catch(function (e) { appendEvent('error', '预览失败：' + e.message, 'err'); });
  }

  /**
   * 报告内嵌预览。
   * 主路径用 blob URL（还能顺手支持"在新标签打开"）；宿主不支持或抛错时退化到
   * iframe srcdoc —— 退化本身不能把"报告没生成"和"预览控件坏了"混成一条文案，
   * 所以这里的异常单独捕获并如实上报。
   */
  function setReportBlob(html) {
    var frame = document.getElementById('report');
    var empty = document.getElementById('report-empty');
    try {
      if (window.URL && typeof URL.createObjectURL === 'function') {
        if (frame.dataset.url) URL.revokeObjectURL(frame.dataset.url);
        var url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        frame.dataset.url = url;
        frame.src = url;
      } else {
        frame.dataset.url = '';
        frame.srcdoc = html;
      }
      empty.style.display = 'none';
      document.getElementById('report-note').textContent =
        '报告 ' + html.length + ' 字符 · 渲染模块 M16 产出' +
        (frame.dataset.url ? '' : '（宿主不支持 blob URL，已用 srcdoc 内嵌）');
      document.getElementById('btn-open-report').disabled = !frame.dataset.url;
    } catch (e) {
      empty.style.display = 'block';
      empty.textContent = '报告已生成，但内嵌预览失败：' + e.message + '（可在「产物」标签页下载 report_html）';
    }
  }

  function loadReport() {
    if (!state.jobId) return;
    var jobId = state.jobId;
    fetch(api + '/jobs/' + encodeURIComponent(jobId) + '/report', { headers: headers() })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120)); });
        return r.text();
      })
      .then(function (html) { if (state.jobId === jobId) setReportBlob(html); })
      .catch(function (e) {
        var em = document.getElementById('report-empty');
        em.style.display = 'block';
        em.textContent = '报告尚未产出（' + e.message + '）';
      });
  }

  function connectStream(jobId) {
    if (state.stream) { try { state.stream.abort(); } catch (x) {} state.stream = null; }
    var ctrl = new AbortController();
    state.stream = ctrl;
    var h = headers();
    if (state.lastSeq != null) h['Last-Event-ID'] = String(state.lastSeq);
    fetch(api + '/jobs/' + encodeURIComponent(jobId) + '/stream', { headers: h, signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
        appendEvent('stream.open', '已连接事件流' +
          (state.lastSeq != null ? '（续传自 #' + state.lastSeq + '）' : '（全量回放）'), 'ok');
        var reader = r.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += dec.decode(res.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\\n\\n')) >= 0) { handleFrame(buf.slice(0, idx)); buf = buf.slice(idx + 2); }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        if (ctrl.signal.aborted) return;
        appendEvent('stream.error', '事件流中断：' + e.message + '（3 秒后重连）', 'err');
        setTimeout(function () { if (state.jobId === jobId) connectStream(jobId); }, 3000);
      });
  }

  function handleFrame(frame) {
    var type = '', data = '', id = null;
    frame.split('\\n').forEach(function (line) {
      if (line.indexOf('event: ') === 0) type = line.slice(7);
      else if (line.indexOf('data: ') === 0) data += line.slice(6);
      else if (line.indexOf('id: ') === 0) id = line.slice(4);
    });
    if (id && /^[0-9]+$/.test(id)) state.lastSeq = Number(id);
    if (!type || type === 'heartbeat') return;
    var payload = {};
    try { payload = data ? JSON.parse(data) : {}; } catch (x) { payload = { raw: data }; }
    renderEvent(type, payload);
  }

  function renderEvent(type, e) {
    switch (type) {
      case 'job.status': {
        var pct = Math.round((((e.progress || {}).percent) || 0) * 100);
        var bar = document.querySelector('#job-card .bar > i');
        if (bar) bar.style.width = pct + '%';
        break;
      }
      case 'phase.start':
        appendEvent(type, '开始（预计 ' + Math.round((e.estimatedMs || 0) / 1000) + 's）', '', e.phase); break;
      case 'phase.progress':
        appendEvent(type, Math.round((e.percent || 0) * 100) + '%' + (e.note ? ' · ' + e.note : ''), '', e.phase); break;
      case 'phase.complete':
        appendEvent(type, e.summary, e.degraded ? 'warn' : 'ok', e.phase); loadDetail(); break;
      case 'agent.delta':
        pushLive(e); return;
      case 'cost.update':
        appendEvent(type, money(e.amount) + ' · ' + (((e.tokens || {}).calls) || 0) + ' 次调用', ''); break;
      case 'data.degraded':
        appendEvent(type, e.source + ' ' + e.reason + ' 缺失：' + (e.missing || []).slice(0, 3).join(' | '), 'warn'); break;
      case 'governance.block':
        appendEvent(type, e.tool + ' ' + e.code + ' ' + e.reason + (e.fatal ? '（致命）' : ''), 'err'); break;
      case 'artifact.ready':
        appendEvent(type, '产物就绪：' + e.kind, 'ok');
        if (e.kind === 'report_html') { loadArtifacts(); loadReport(); }
        break;
      case 'job.error':
        appendEvent(type, e.code + ' ' + (e.traceId || ''), 'err'); break;
      case 'job.done':
        appendEvent(type, '任务结束 · 成本 ' + money((e.usage || {}).cost), 'ok');
        loadJobs(); loadDetail(); loadArtifacts(); loadReport();
        break;
      case 'view.snapshot':
        appendEvent(type, '缓冲过期，已切换视图快照 status=' + e.status, 'warn'); loadDetail(); break;
      default:
        appendEvent(type, JSON.stringify(e).slice(0, 240), '');
    }
  }

  function pushLive(e) {
    var key = e.agent + '/' + e.kind;
    var b = state.liveBuffers[key] || (state.liveBuffers[key] = { text: '' });
    var box = document.getElementById('live');
    // 用户是否已经在底部：只有贴着底部时才自动跟随，向上翻阅历史时不被拽回
    var following = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    // 保留完整流式正文。上限 20000 仅作防御（单次阶段正文最大约 25KB，
    // 远超此值才会丢最旧内容），不再按 500 字符做硬截断。
    b.text = (b.text + (e.delta || '')).slice(-20000);
    var id = 'live-' + key.replace(/[^a-zA-Z]/g, '_');
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'live-item'; el.id = id;
      el.innerHTML = '<div class="who"></div><div class="txt"></div>';
      box.appendChild(el);
      // 每次任务最多 6 个智能体 × 3 种增量，24 条足以覆盖全部组合且不会无限增长
      while (box.childNodes.length > 24) box.removeChild(box.firstChild);
    }
    el.querySelector('.who').textContent = e.agent + ' · ' +
      (e.kind === 'tool' ? '工具调用' : e.kind === 'thinking' ? '推理' : '正文');
    el.querySelector('.txt').textContent = b.text;
    if (following) box.scrollTop = box.scrollHeight;
  }

  function appendEvent(kind, text, cls, tag) {
    var box = document.getElementById('events');
    var row = document.createElement('div');
    row.className = 'row ' + (cls || '');
    row.innerHTML = '<span class="t">' + clock() + '</span><span class="k">' + esc(tag || kind) + '</span>' +
      '<span class="v">' + esc(text) + '</span>';
    box.appendChild(row);
    while (box.childNodes.length > 400) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.className = b.getAttribute('data-tab') === name ? 'on' : '';
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
      p.className = 'panel' + (p.getAttribute('data-panel') === name ? ' on' : '');
    });
  }

  function submitBrief() {
    var btn = document.getElementById('btn-submit');
    var hint = document.getElementById('submit-hint');
    var platforms = Array.prototype.map.call(
      document.querySelectorAll('#f-platforms input:checked'),
      function (c) { return c.value; });
    if (!platforms.length) platforms = ['douyin'];
    var w = {
      awareness: Number(document.getElementById('f-wa').value),
      conversion: Number(document.getElementById('f-wc').value),
      retention: Number(document.getElementById('f-wr').value)
    };
    if (Math.abs(w.awareness + w.conversion + w.retention - 1) > 0.051) {
      hint.style.color = '#c62828';
      hint.textContent = '三个目标权重之和需为 1（当前 ' + (w.awareness + w.conversion + w.retention).toFixed(2) + '）';
      return;
    }
    var brief = {
      industry: document.getElementById('f-industry').value.trim(),
      category: document.getElementById('f-category').value.trim(),
      brandIds: document.getElementById('f-brands').value.split(',')
        .map(function (s) { return s.trim(); }).filter(Boolean),
      budget: { currency: 'CNY', amount: Math.round(Number(document.getElementById('f-budget').value) * 10000) },
      objectiveWeights: w,
      window: { from: document.getElementById('f-from').value, to: document.getElementById('f-to').value },
      platforms: platforms,
      notes: document.getElementById('f-notes').value.trim()
    };
    btn.disabled = true; btn.textContent = '提交中…';
    req(api + '/jobs', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: { brief: brief } })
      .then(function (r) {
        hint.style.color = '#12864a';
        hint.textContent = '任务已创建：' + r.job.jobId + (r.reused ? '（命中幂等键，复用已有任务）' : '');
        document.getElementById('events').innerHTML = '';
        document.getElementById('live').innerHTML = '';
        selectJob(r.job.jobId);
      })
      .catch(function (e) { hint.style.color = '#c62828'; hint.textContent = '提交失败：' + e.message; })
      .then(function () { btn.disabled = false; btn.textContent = '提交并开始执行'; });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'idem-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  document.getElementById('token').value = localStorage.getItem('bm_token') || CFG.defaultToken;
  document.getElementById('btn-save-token').addEventListener('click', function () {
    localStorage.setItem('bm_token', token());
    document.getElementById('submit-hint').textContent = 'Token 已保存，正在刷新…';
    loadHealth(); loadJobs();
    if (state.jobId) { loadDetail(); loadArtifacts(); }
  });
  document.getElementById('btn-submit').addEventListener('click', submitBrief);
  document.getElementById('btn-reload-jobs').addEventListener('click', loadJobs);
  document.getElementById('btn-open-report').addEventListener('click', function () {
    var url = document.getElementById('report').dataset.url;
    if (url) window.open(url, '_blank');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });

  loadHealth();
  loadJobs();
  setInterval(loadHealth, 30000);
})();
</script>
</body>
</html>`;
}
