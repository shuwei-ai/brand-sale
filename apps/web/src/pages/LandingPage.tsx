import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Button, Segmented, Tag } from "antd";
import { useNavigate } from "react-router-dom";
import {
  ApartmentOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  ExperimentOutlined,
  FileTextOutlined,
  ForkOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { PALETTE } from "../theme.ts";
import "./landing.css";

/**
 * 落地页。
 *
 * 刻意不做成独立的营销站：它跑在同一个 Vite 产物里、用同一份 antd 主题令牌、
 * 同一个字体栈与圆角体系，只是把「控制台的产品长相」放大了讲一遍。
 * 颜色一律从 theme.ts 的 PALETTE 取，页面内不出现第二份色值定义 ——
 * 否则控制台改版时落地页会悄悄变成另一套视觉。
 */

/** 六个阶段。与后端 phases 一一对应，顺序即执行顺序。 */
const PHASES = [
  {
    idx: "01",
    en: "Brief",
    cn: "结构化需求",
    desc: "一句话需求拆成可执行 brief：品类、平台、目标权重、约束。自然语言解析只回填表单，结构化字段才是唯一提交契约。",
    out: "brief.json",
    gate: "—",
  },
  {
    idx: "02",
    en: "Intel",
    cn: "情报",
    desc: "平台正文、评论、创作者与公开网页检索。模型只有一个聚合入口 platform_digest，七个单平台工具对它隐藏。",
    out: "intel_evidence",
    gate: "scope · source · authz · tenant",
  },
  {
    idx: "03",
    en: "Talent",
    cn: "人选",
    desc: "候选只来自采集到的账号池，或本次公开检索命中里真实出现过的姓名。粉丝量与报价拿不到就写 gap，不估价、不补数。",
    out: "creator_candidates",
    gate: "来源 + 报价库授权",
  },
  {
    idx: "04",
    en: "Playbook",
    cn: "打法",
    desc: "内容支柱、节奏、渠道组合与话术方向。拆解出的每条约束都要被逐条回应，漏项自动补 gap 并记入降级项。",
    out: "playbook",
    gate: "角色白名单",
  },
  {
    idx: "05",
    en: "Budget",
    cn: "预算",
    desc: "分渠道预算与 ROI 假设。越界即被语义红线拦下并写审计——不是提示词里的一句嘱咐，是代码里的一次判断。",
    out: "budget",
    gate: "语义红线 · 预算上限",
  },
  {
    idx: "06",
    en: "Report",
    cn: "报告",
    desc: "DSL 渲染成 HTML / Markdown。数字断言没有 citation 或有效 sourceRef 就出不了稿；未指定自有品牌时，页面上连「我方」都不许出现。",
    out: "report_dsl · html · md",
    gate: "R6 · R13 · R14",
  },
] as const;

/** 首屏右侧那张「正在跑的任务卡」——照控制台任务详情的真实结构画，不画虚构图表。 */
const PREVIEW_PHASES = [
  { name: "intake", cn: "Brief", state: "ok", time: "12.4s" },
  { name: "intel", cn: "情报", state: "ok", time: "2m18s" },
  { name: "creator", cn: "人选", state: "warn", time: "1m02s" },
  { name: "playbook", cn: "打法", state: "ok", time: "48s" },
  { name: "budget", cn: "预算", state: "ok", time: "21s" },
  { name: "report", cn: "报告", state: "ok", time: "1m35s" },
] as const;

const STATS: { num: string; key: string; desc: string; accent?: boolean }[] = [
  { num: "06", key: "阶段", desc: "独立检查点，可单模块重算" },
  { num: "08", key: "数据源", desc: "1 联网检索 + 7 平台公开采集" },
  { num: "18", key: "工具", desc: "逐个过闸门，来源由代码绑定" },
  { num: "294", key: "回归用例", desc: "全离线，不依赖外部服务" },
  { num: "00", key: "无源数字", desc: "被 R6 / R13 拦下的编造引用", accent: true },
];

const GATES = [
  {
    no: "1",
    icon: <ForkOutlined />,
    title: "能力默认关闭",
    body: "引入一个非商用采集内核是一个决定，不是一个配置项。必须显式确认许可，能力才会被装配——三道门缺一道，七个采集工具就根本不在工具清单里。",
  },
  {
    no: "2",
    icon: <SafetyCertificateOutlined />,
    title: "四项检查，来源由代码绑定",
    body: "scope / source / authz / tenant 逐项检查。工具绑定的来源写在代码里，不由模型参数决定：否则模型换一个已登记的 id，闸门就会去检查错的对象。",
  },
  {
    no: "3",
    icon: <ApartmentOutlined />,
    title: "语义红线",
    body: "预算越界、跨租户引用、未核验来源，触发即拒绝，并同时写进审计明细与报告末页的「排除项」。失败要留名，不能静默。",
  },
] as const;

const CASCADE = [
  { tag: "L1", title: "Agent 循环", body: "工具调用 + 白名单钩子，模型自己决定下一步查什么。绝大多数任务走到这一层就结束。" },
  { tag: "L2", title: "直连结构化输出", body: "循环失败时直接要一份结构化 JSON；校验错误回喂重试，连续失败再往下走。" },
  { tag: "L3", title: "实测数据 + 保守模板", body: "工具实测数据填进合成模板，缺失项显式标为排除项。这类报告会被标注来源，不伪装成模型原稿。" },
] as const;

/** 溯源演示的两个平台。字段名与采集侧落盘一致，不是编的。 */
const TRACE = {
  xhs: {
    label: "小红书",
    raw: [
      '{"collectedAt":"2026-10-28T08:12:44Z",',
      ' "row":{"platform":"xhs",',
      '        "noteId":"6a2c9f…",',
      '        "title":"秋冬精华实测：三个成分够用",',
      '        "likedCount":12480,',
      '        "sourceKeyword":"精华 测评"}}',
    ],
    entry: [
      "entryId    pf_xhs_6a2c9f…",
      "platform   xhs",
      "title      秋冬精华实测：三个成分够用",
      "posted     2026-10-26",
      "provenance L3 · 公开 · 未经人工核验",
    ],
    claim: "成分向笔记的互动中位数最高，其次才是「省钱攻略」。",
    resolved: "xiaohongshu.com/explore/6a2c9f…",
    note: "编造的编号过不了 R13 校验，会被降级成来源级引用并在附录标注。",
  },
  dy: {
    label: "抖音",
    raw: [
      '{"collectedAt":"2026-10-28T08:19:02Z",',
      ' "row":{"platform":"dy",',
      '        "awemeId":"7391…",',
      '        "title":"成分党别再交智商税了",',
      '        "diggCount":38600,',
      '        "sourceKeyword":"精华 测评"}}',
    ],
    entry: [
      "entryId    pf_dy_7391ab…",
      "platform   dy",
      "title      成分党别再交智商税了",
      "posted     2026-10-27",
      "provenance L3 · 公开 · 未经人工核验",
    ],
    claim: "短视频侧的互动集中在「避坑」型选题，与图文侧的务实测评形成互补。",
    resolved: "douyin.com/video/7391…",
    note: "跨平台只做定性对照：抖音无评论数、小红书无播放量，交集指标不足以支撑数值比较。",
  },
} as const;

type TraceKey = keyof typeof TRACE;

export function LandingPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TraceKey>("xhs");

  /** 站内锚点：HashRouter 下 href="#x" 会被当成路由，所以统一用滚动而不是 a[href]。 */
  const jump = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /* 滚动入场：只加 class，位移与时长全在 CSS 里，方便统一降级 */
  useEffect(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>(".lp-reveal"));
    if (!items.length) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      items.forEach((el) => el.classList.add("is-in"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  /** 色值单一来源：CSS 变量全部由 PALETTE 注入，landing.css 里不写死色值 */
  const vars = {
    "--lp-primary": PALETTE.primary,
    "--lp-primary-soft": PALETTE.primarySoft,
    "--lp-ink": PALETTE.ink,
    "--lp-ink2": PALETTE.ink2,
    "--lp-ink3": PALETTE.ink3,
    "--lp-line": PALETTE.line,
    "--lp-bg": PALETTE.bgLayout,
    "--lp-ok": PALETTE.ok,
    "--lp-warn": PALETTE.warn,
  } as CSSProperties;

  const t = TRACE[tab];

  return (
    <div className="lp" style={vars} id="top">
      {/* ── 顶栏：与 AppShell 的 .bm-header 同一套玻璃拟态 ───────── */}
      <header className="lp-bar">
        <div className="lp-bar__in">
          <a className="lp-brand" href="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            <span className="lp-brand__mark" aria-hidden>
              B
            </span>
            <span className="lp-brand__text">
              <strong>brandsale</strong>
              <span>品牌营销 AI 策略咨询</span>
            </span>
          </a>

          <nav className="lp-nav" aria-label="页面导航">
            {[
              ["pipeline", "流水线"],
              ["governance", "治理"],
              ["provenance", "溯源"],
              ["cascade", "降级"],
              ["run", "运行"],
            ].map(([id, label]) => (
              <button key={id} type="button" className="lp-nav__item" onClick={() => jump(id)}>
                {label}
              </button>
            ))}
          </nav>

          <Button type="primary" onClick={() => navigate("/jobs/new")}>
            进入控制台
          </Button>
        </div>
      </header>

      <main>
        {/* ── 首屏 ─────────────────────────────────────────────── */}
        <section className="lp-hero" aria-labelledby="lp-hero-title">
          <div className="lp-hero__grid" aria-hidden />
          <div className="lp-wrap lp-hero__in">
            <div className="lp-hero__copy">
              <p className="lp-eyebrow">
                六阶段 · 8 个数据源 · 18 个工具 · 294 个离线用例
              </p>
              <h1 className="lp-hero__title" id="lp-hero-title">
                从一句话，
                <br />
                到一份<em>可溯源</em>的策略报告
              </h1>
              <p className="lp-hero__lede">
                Brief → 情报 → 人选 → 打法 → 预算 → 报告，六阶段由多智能体接力完成，数据只能从治理闸门进出。
                模型写报告时<strong>只引用系统生成的条目号</strong>，原文链接与发布时间由渲染层反查证据表拼出——
                它手里没有编造一条 URL 的能力。
              </p>
              <div className="lp-hero__cta">
                <Button type="primary" size="large" onClick={() => navigate("/jobs/new")}>
                  新建一个任务 <ArrowRightOutlined />
                </Button>
                <Button size="large" onClick={() => jump("provenance")}>
                  看它怎么溯源
                </Button>
              </div>
              <p className="lp-hero__hint">
                <CheckCircleFilled />
                <span className="lp-t">
                  无需外部服务即可跑通全链路：<code>npm test</code> 全离线，
                  <code>npm run demo:mock</code> 输出确定性结果。
                </span>
              </p>
            </div>

            {/* 右侧：照任务详情页的真实结构画的任务卡 */}
            <div className="lp-jobcard" role="img" aria-label="任务详情页示意：六个阶段执行状态、降级项与排除项">
              <div className="lp-jobcard__bar">
                <span className="lp-jobcard__dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                <span className="lp-jobcard__path">#/jobs/jb_20261028_0142</span>
                <Tag color="processing" style={{ marginInlineEnd: 0 }}>
                  进行中
                </Tag>
              </div>

              <div className="lp-jobcard__head">
                <p className="lp-jobcard__title">精华品类 · 达人结构诊断</p>
                <p className="lp-jobcard__meta">
                  某护肤品牌 · 小红书 / 抖音 · 预算上限 ¥ 80 万
                </p>
              </div>

              <ul className="lp-jobcard__rows">
                {PREVIEW_PHASES.map((p) => (
                  <li key={p.name} className={p.state === "warn" ? "is-warn" : undefined}>
                    <span className="lp-jobcard__dot" aria-hidden />
                    <span className="lp-jobcard__en">{p.name}</span>
                    <span className="lp-jobcard__cn">{p.cn}</span>
                    <span className="lp-jobcard__state">{p.state === "warn" ? "部分成功" : "成功"}</span>
                    <span className="lp-jobcard__time">{p.time}</span>
                  </li>
                ))}
              </ul>

              <div className="lp-jobcard__foot">
                <span>
                  <RollbackOutlined /> 降级 1 项
                </span>
                <span>排除项 2 条</span>
                <span className="lp-jobcard__ok">
                  <CheckCircleFilled /> 12 条引用可回溯
                </span>
              </div>
            </div>
          </div>

          {/* 阶段轨：六个节点一条线，不是三张卡 */}
          <div className="lp-wrap">
            <ol className="lp-rail">
              {PHASES.map((p) => (
                <li key={p.idx}>
                  <span className="lp-rail__dot" aria-hidden />
                  <span className="lp-rail__idx">{p.idx}</span>
                  <span className="lp-rail__en">{p.en}</span>
                  <span className="lp-rail__cn">{p.cn}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── 数字条 ───────────────────────────────────────────── */}
        <section className="lp-stats" aria-label="系统概况">
          <div className="lp-wrap lp-stats__in">
            {STATS.map((s) => (
              <div className="lp-stat" key={s.key}>
                <span className={s.accent ? "lp-stat__num is-accent" : "lp-stat__num"}>{s.num}</span>
                <span className="lp-stat__key">{s.key}</span>
                <span className="lp-stat__desc">{s.desc}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── 流水线 ───────────────────────────────────────────── */}
        <section className="lp-sec" id="pipeline" aria-labelledby="lp-pipeline-title">
          <div className="lp-wrap">
            <header className="lp-sec__head lp-reveal">
              <p className="lp-eyebrow">01 / 流水线</p>
              <h2 className="lp-h2" id="lp-pipeline-title">
                六个阶段，一条单向链路
              </h2>
              <p className="lp-sub">
                每个阶段落一份产物、记一次血缘；失败时降级而不是中断。重算任一阶段，其下游会一起重跑。
              </p>
            </header>

            <ol className="lp-flow">
              {PHASES.map((p) => (
                <li className="lp-flow__row lp-reveal" key={p.idx}>
                  <span className="lp-flow__idx">{p.idx}</span>
                  <div className="lp-flow__main">
                    <h3 className="lp-flow__name">
                      {p.en}
                      <span>{p.cn}</span>
                    </h3>
                    <p>{p.desc}</p>
                  </div>
                  <div className="lp-flow__meta">
                    <span className="lp-chip lp-chip--solid">产物</span>
                    <code>{p.out}</code>
                    <span className="lp-chip">闸门</span>
                    <code className="lp-flow__gate">{p.gate}</code>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── 治理（深色块，呼应控制台的终端配色）──────────────── */}
        <section className="lp-dark" id="governance" aria-labelledby="lp-gov-title">
          <div className="lp-wrap">
            <header className="lp-sec__head lp-reveal">
              <p className="lp-eyebrow lp-eyebrow--dark">02 / 治理</p>
              <h2 className="lp-h2 lp-h2--dark" id="lp-gov-title">
                闸门是唯一通路
              </h2>
              <p className="lp-sub lp-sub--dark">
                所有数据访问都过同一道闸门。未登记来源、法务未批、跨租户、语义越界——一律拦截，
                且拦截会留下痕迹，不会变成一句「暂无数据」。
              </p>
            </header>

            <div className="lp-gates">
              {GATES.map((g) => (
                <article className="lp-gate lp-reveal" key={g.no}>
                  <div className="lp-gate__top">
                    <span className="lp-gate__icon" aria-hidden>
                      {g.icon}
                    </span>
                    <span className="lp-gate__no">{g.no}</span>
                  </div>
                  <h3>{g.title}</h3>
                  <p>{g.body}</p>
                </article>
              ))}
            </div>

            <p className="lp-dark__foot lp-reveal">
              每一条访问都会记一行血缘：来源、行数、时点、产物。
              <span>报告末尾的「数据来源与溯源」页由机器生成，不是模型写的。</span>
            </p>
          </div>
        </section>

        {/* ── 溯源演示 ─────────────────────────────────────────── */}
        <section className="lp-sec" id="provenance" aria-labelledby="lp-trace-title">
          <div className="lp-wrap">
            <header className="lp-sec__head lp-reveal">
              <p className="lp-eyebrow">03 / 溯源</p>
              <h2 className="lp-h2" id="lp-trace-title">
                模型只拿到编号，拿不到 URL
              </h2>
              <p className="lp-sub">
                采集工具返回结果的同时，把条目登记进本任务的证据表。报告里出现的每一处平台数据都是一个条目号；
                渲染层拿编号反查证据表，把标题、原文链接、发布时间拼回去。
              </p>
            </header>

            <div className="lp-trace lp-reveal">
              <div className="lp-trace__head">
                <Segmented
                  value={tab}
                  onChange={(v) => setTab(v as TraceKey)}
                  options={[
                    { label: "小红书", value: "xhs" },
                    { label: "抖音", value: "dy" },
                  ]}
                />
                <span className="lp-trace__hint">切换平台，同一条链路</span>
              </div>

              <div className="lp-trace__chain">
                <div className="lp-step">
                  <span className="lp-step__no">1</span>
                  <h4>采集行</h4>
                  <pre className="lp-code">
                    <code>{t.raw.join("\n")}</code>
                  </pre>
                  <p>落盘一行即入库一行，采集词逐字保留在 source_keyword。</p>
                </div>

                <span className="lp-step__arrow" aria-hidden>
                  <ArrowRightOutlined />
                </span>

                <div className="lp-step">
                  <span className="lp-step__no">2</span>
                  <h4>证据表条目</h4>
                  <pre className="lp-code">
                    <code>{t.entry.join("\n")}</code>
                  </pre>
                  <p>条目号由系统生成，模型只能引用，不能发明。</p>
                </div>

                <span className="lp-step__arrow" aria-hidden>
                  <ArrowRightOutlined />
                </span>

                <div className="lp-step">
                  <span className="lp-step__no">3</span>
                  <h4>报告里的引用</h4>
                  <blockquote className="lp-quote">{t.claim}</blockquote>
                  <p className="lp-step__resolved">
                    渲染后 →<span className="lp-step__url">{t.resolved}</span>
                    <em>链接由系统拼接</em>
                  </p>
                  <p>{t.note}</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── 降级 ─────────────────────────────────────────────── */}
        <section className="lp-sec lp-sec--tight" id="cascade" aria-labelledby="lp-cascade-title">
          <div className="lp-wrap">
            <header className="lp-sec__head lp-reveal">
              <p className="lp-eyebrow">04 / 降级</p>
              <h2 className="lp-h2" id="lp-cascade-title">
                任何一级失败，都不中断任务
              </h2>
              <p className="lp-sub">能拿到多少就说多少，拿不到的进「排除项」，置信度跟着降。</p>
            </header>

            <ol className="lp-cascade">
              {CASCADE.map((c) => (
                <li className="lp-cascade__item lp-reveal" key={c.tag}>
                  <span className="lp-cascade__tag">{c.tag}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </li>
              ))}
            </ol>

            <p className="lp-note lp-reveal">
              <ExperimentOutlined />
              <span className="lp-t">
                所以看到「成功」两个字也别急着信：判断一份报告是不是兜底产出的，要看
                <code>meta.degraded</code> 是否为空。这条规则写进了项目文档，也写在了控制台上。
              </span>
            </p>
          </div>
        </section>

        {/* ── 运行 ─────────────────────────────────────────────── */}
        <section className="lp-sec" id="run" aria-labelledby="lp-run-title">
          <div className="lp-wrap lp-run">
            <div className="lp-reveal">
              <p className="lp-eyebrow">05 / 运行</p>
              <h2 className="lp-h2" id="lp-run-title">
                两条命令，跑起来
              </h2>
              <p className="lp-sub">
                没有任何外部服务依赖也能跑完整个链路。接真实模型只需在 <code>.env</code> 里换三个变量，不改代码。
              </p>
              <div className="lp-hero__cta">
                <Button type="primary" size="large" onClick={() => navigate("/jobs/new")}>
                  打开控制台
                </Button>
                <Button size="large" onClick={() => jump("pipeline")}>
                  回看流水线
                </Button>
              </div>
            </div>

            <div className="lp-terminal lp-reveal">
              <div className="lp-terminal__bar">
                <i />
                <i />
                <i />
                <span>~/code/brandsale</span>
              </div>
              <pre>
                <code>
                  <span className="lp-t-prompt">$</span> npm install &amp;&amp; npm test{"\n"}
                  <span className="lp-t-dim">  294 个用例通过 · 全离线 · 不依赖外部服务</span>
                  {"\n\n"}
                  <span className="lp-t-prompt">$</span> npm start{"\n"}
                  <span className="lp-t-dim">  gateway listening on </span>
                  http://127.0.0.1:8787{"\n"}
                  <span className="lp-t-dim">  console + report served on the same port</span>
                  {"\n\n"}
                  <span className="lp-t-prompt">$</span> npm run demo:mock{"\n"}
                  <span className="lp-t-dim">  6 phases · deterministic output · 无 key 可跑</span>
                </code>
              </pre>
            </div>
          </div>

          <div className="lp-wrap">
            <aside className="lp-license lp-reveal" aria-label="许可说明">
              <span className="lp-license__k" aria-hidden>
                <FileTextOutlined />
              </span>
              <p>
                <strong>关于许可，写在这里因为它重要：</strong>
                内嵌的采集内核来自 MediaCrawler，许可证为 NON-COMMERCIAL LEARNING LICENSE 1.1，
                第 3 条禁止未经版权方书面同意的任何商业用途。因此整条链路有三道门——
                <code>BM_MC_ENABLED</code> + <code>BM_MC_LICENSE_ACK</code> + <code>BM_MC_COLLECTOR_URL</code>，
                少一道，七个采集工具就不装配。商业授权凭据目前仍然空缺，我们不假装它已经解决。
              </p>
            </aside>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot__in">
          <div>
            <p className="lp-foot__word">brandsale</p>
            <p className="lp-foot__cn">品牌营销 AI 策略咨询系统 · Phase 1 可运行纵切</p>
          </div>
          <div className="lp-foot__col">
            <span>产物</span>
            <p>HTML 报告 / Markdown / DSL</p>
          </div>
          <div className="lp-foot__col">
            <span>接口</span>
            <p>/api/v1/jobs · /jobs/:id/stream</p>
          </div>
          <div className="lp-foot__col">
            <span>入口</span>
            <p>
              <button type="button" className="lp-linkbtn" onClick={() => navigate("/jobs/new")}>
                控制台
              </button>
              {" · "}
              <button type="button" className="lp-linkbtn" onClick={() => navigate("/governance")}>
                治理台账
              </button>
            </p>
          </div>
        </div>
        <p className="lp-wrap lp-foot__fine">
          本页所有数字都来自项目自身的实测与用例基线；页面上没有一个占位统计。
        </p>
      </footer>
    </div>
  );
}
