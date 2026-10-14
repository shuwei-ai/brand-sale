import { Card, Col, Row, Space, Tooltip, Typography } from "antd";
import type { PhaseName } from "@brandsale/contracts";
import { DEGRADE_LABEL } from "../theme.ts";
import type { PhaseWithLabel } from "../api/types.ts";
import { StatusTag } from "./StatusTag.tsx";

/** 阶段状态 → 顶部强调色。集中在这里，避免每个调用点各挑一次颜色。 */
const ACCENT: Record<string, string> = {
  pending: "#d9ddeb",
  running: "#4f46e5",
  succeeded: "#0e8a4d",
  partial: "#b25e00",
  failed: "#c62828",
  skipped: "#d9ddeb",
};

const money = (m?: { amount?: number }): string => `¥${Number(m?.amount ?? 0).toFixed(4)}`;

/**
 * 六阶段看板。
 *
 * 阶段顺序由后端返回的 `order` 决定（= PHASE_ORDER），不在这里硬编码：
 * 加阶段时前端不需要改。
 */
export function PhaseBoard({ phases, order }: { phases: PhaseWithLabel[]; order: PhaseName[] }) {
  const byPhase = new Map(phases.map((p) => [p.phase, p]));

  return (
    <Row gutter={[8, 8]}>
      {order.map((name, i) => {
        const st = byPhase.get(name);
        const status = st?.status ?? "pending";
        const accent = ACCENT[status] ?? ACCENT.pending!;
        return (
          <Col key={name} xs={12} sm={8} lg={8} xl={4}>
            <Card
              size="small"
              style={{ borderTop: `3px solid ${accent}`, height: "100%" }}
              styles={{ body: { padding: "9px 11px", minHeight: 92 } }}
            >
              <Space size={6} style={{ marginBottom: 4 }}>
                <span
                  className="bm-mono"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 18,
                    height: 18,
                    borderRadius: 6,
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: accent === "#d9ddeb" ? "#8a92a6" : "#fff",
                    background: accent,
                  }}
                >
                  {i + 1}
                </span>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  {st?.label ?? name}
                </Typography.Text>
              </Space>
              <div style={{ marginBottom: 2 }}>
                <StatusTag status={status} />
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: "block" }}>
                尝试 {st?.attempts ?? 0} 次 · {money(st?.cost)}
              </Typography.Text>
              {st?.errorCode ? (
                <Tooltip title={st.errorMessage ?? ""}>
                  <Typography.Text type="danger" style={{ fontSize: 11, display: "block" }} ellipsis>
                    {st.errorCode}
                  </Typography.Text>
                </Tooltip>
              ) : null}
              {st?.degraded ? (
                <Tooltip title={st.degraded.note ?? (st.degraded.missing ?? []).join(" | ")}>
                  <Typography.Text type="warning" style={{ fontSize: 11, display: "block" }} ellipsis>
                    已降级 · {DEGRADE_LABEL[st.degraded.reason] ?? st.degraded.reason}
                  </Typography.Text>
                </Tooltip>
              ) : null}
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
