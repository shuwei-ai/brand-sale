import type { ThemeConfig } from "antd";

/** 品牌色板。沿用初版控制台的视觉基调，改版不换肤。 */
export const PALETTE = {
  primary: "#4f46e5",
  primarySoft: "#eef0fe",
  ok: "#0e8a4d",
  warn: "#b25e00",
  err: "#c62828",
  ink: "#191d27",
  ink2: "#4b5364",
  ink3: "#8a92a6",
  line: "#e7eaf1",
  bgLayout: "#f4f5fa",
} as const;

/**
 * Ant Design 主题令牌。
 *
 * 只覆盖必要的令牌，不逐个组件写样式：一旦开始给组件写 `style={{}}`，
 * 设计系统就退化成散落的魔法数字，后续改版要满仓库找。
 */
export const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: PALETTE.primary,
    colorInfo: PALETTE.primary,
    colorSuccess: PALETTE.ok,
    colorWarning: PALETTE.warn,
    colorError: PALETTE.err,
    colorTextBase: PALETTE.ink,
    colorBgLayout: PALETTE.bgLayout,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif',
    fontFamilyCode: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    borderRadius: 8,
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: "rgba(255,255,255,0.88)",
      headerHeight: 56,
      headerPadding: "0 20px",
      siderBg: "#ffffff",
      bodyBg: PALETTE.bgLayout,
    },
    Menu: { itemBorderRadius: 8, itemHeight: 38, itemMarginInline: 8 },
    Card: { headerFontSize: 13, paddingLG: 18 },
    Table: { headerBg: "#fafbfe", headerSplitColor: "transparent", rowHoverBg: "#f8f9fd" },
    Descriptions: { labelBg: "#fafbfe" },
  },
};

/** 阶段状态 → Ant Design Tag 颜色 */
export const STATUS_COLOR: Record<string, string> = {
  queued: "default",
  running: "processing",
  succeeded: "success",
  partial: "warning",
  failed: "error",
  cancelled: "default",
  pending: "default",
  skipped: "default",
};

export const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "成功",
  partial: "部分成功",
  failed: "失败",
  cancelled: "已取消",
  pending: "待执行",
  skipped: "已跳过",
};

/** 降级原因中文名。缺省直接显示原码，不为未知码编造文案。 */
export const DEGRADE_LABEL: Record<string, string> = {
  authz_expired: "授权过期",
  source_blocked: "来源被阻断",
  source_not_registered: "来源未登记",
  timeout: "超时",
  unavailable: "不可用",
  rate_limited: "限流",
  no_data: "无数据",
  rerank_timeout: "重排超时",
  rerank_disabled: "重排关闭",
  partial_output: "产出不完整",
  gate_fail_closed: "闸门 fail-closed",
};
