import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ArrowLeftOutlined, RedoOutlined, StopOutlined } from "@ant-design/icons";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PHASE_LABEL, type PhaseName } from "@brandsale/contracts";
import { api } from "../api/endpoints.ts";
import type { LedgerEntry } from "../api/types.ts";
import { useAsync } from "../hooks/useAsync.ts";
import { useJobStream } from "../hooks/useJobStream.ts";
import { DEGRADE_LABEL } from "../theme.ts";
import { PhaseBoard } from "../components/PhaseBoard.tsx";
import { LiveConsole } from "../components/LiveConsole.tsx";
import { EventTerminal } from "../components/EventTerminal.tsx";
import { ReportPreview } from "../components/ReportPreview.tsx";
import { ArtifactPanel } from "../components/ArtifactPanel.tsx";
import { StatusTag } from "../components/StatusTag.tsx";

const clock = (iso?: string): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
};

export function JobDetailPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { jobId = "" } = useParams<{ jobId: string }>();

  const [tab, setTab] = useState("events");
  const [artifactTick, setArtifactTick] = useState(0);
  const [reportTick, setReportTick] = useState(0);
  const [livePercent, setLivePercent] = useState<number | null>(null);
  const [livePhase, setLivePhase] = useState<PhaseName | null>(null);
  const [followLog, setFollowLog] = useState(true);
  const [rerunPhase, setRerunPhase] = useState<PhaseName>("report");
  const [busy, setBusy] = useState(false);

  const detail = useAsync(
    async () => {
      const [job, phases, usage, ledger] = await Promise.all([
        api.getJob(jobId).then((r) => r.job),
        api.listPhases(jobId),
        api.getUsage(jobId),
        api.getLedger(jobId).then((r) => r.items).catch(() => [] as LedgerEntry[]),
      ]);
      return { job, phases, usage, ledger };
    },
    [jobId],
  );

  useEffect(() => {
    setLivePercent(null);
    setLivePhase(null);
    setArtifactTick(0);
    setReportTick(0);
  }, [jobId]);

  /**
   * 事件 → 数据的同步策略。
   *
   * 不是每个事件都值得重拉详情：`job.status` 与 `phase.progress` 高频，
   * 用事件里的数字直接更新进度即可；只有**状态真正落定**的事件
   * （阶段完成、产物就绪、任务结束、缓冲过期）才值得一次网络往返。
   */
  const stream = useJobStream(jobId || null, (type, payload) => {
    switch (type) {
      case "job.status": {
        const p = (payload.progress ?? {}) as { percent?: number; currentPhase?: PhaseName | null };
        setLivePercent(p.percent ?? null);
        setLivePhase(p.currentPhase ?? null);
        break;
      }
      case "phase.start":
        setLivePhase(payload.phase as PhaseName);
        detail.reload();
        break;
      case "phase.complete":
        detail.reload();
        break;
      case "artifact.ready":
        setArtifactTick((n) => n + 1);
        break;
      case "job.done":
      case "view.snapshot":
        detail.reload();
        setArtifactTick((n) => n + 1);
        setReportTick((n) => n + 1);
        break;
      default:
        break;
    }
  });

  const job = detail.data?.job;
  const phases = detail.data?.phases.items ?? [];
  const order = detail.data?.phases.order ?? [];
  const usage = detail.data?.usage;
  const ledger = detail.data?.ledger ?? [];

  const percent = useMemo(() => {
    if (livePercent !== null) return Math.round(livePercent * 100);
    return Math.round((job?.progress?.percent ?? 0) * 100);
  }, [livePercent, job]);

  const currentPhase = livePhase ?? job?.progress?.currentPhase ?? null;

  const doRerun = async () => {
    setBusy(true);
    try {
      await api.rerunPhase(jobId, rerunPhase);
      message.success(`已触发重跑：${PHASE_LABEL[rerunPhase]}（该阶段及下游）`);
      detail.reload();
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "重跑失败");
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    setBusy(true);
    try {
      await api.cancelJob(jobId, "控制台取消");
      message.warning("已请求取消");
      detail.reload();
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "取消失败");
    } finally {
      setBusy(false);
    }
  };

  const ledgerColumns: ColumnsType<LedgerEntry> = [
    { title: "阶段", dataIndex: "phase", width: 120 },
    { title: "智能体", dataIndex: "agent", width: 90, render: (v: string | null) => v ?? "—" },
    {
      title: "数据输入",
      render: (_: unknown, row) => (
        <Space direction="vertical" size={0}>
          {(row.inputs ?? []).map((i, idx) => (
            <Typography.Text key={idx} style={{ fontSize: 12 }}>
              <Tag color="blue" style={{ fontSize: 10 }}>
                {i.tier}
              </Tag>
              {i.sourceId} · {i.rowCount} 条{i.cached ? "（缓存）" : ""}
            </Typography.Text>
          ))}
          {row.inputs?.length ? null : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              无外部数据访问
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: "输出",
      render: (_: unknown, row) =>
        (row.outputs ?? []).map((o) => o.artifactKind).join(" / ") || "—",
    },
    { title: "开始", dataIndex: "startedAt", width: 180, render: (v: string) => clock(v) },
  ];

  if (detail.loading && !job) {
    return (
      <Card>
        <Spin tip="加载任务详情…">
          <div style={{ height: 120 }} />
        </Spin>
      </Card>
    );
  }

  if (detail.error && !job) {
    return (
      <Card>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={`任务详情加载失败：${detail.error.display}`}
        >
          <Space>
            <Button onClick={() => navigate("/jobs")} icon={<ArrowLeftOutlined />}>
              返回列表
            </Button>
            <Button type="primary" onClick={detail.reload}>
              重试
            </Button>
          </Space>
        </Empty>
      </Card>
    );
  }

  if (!job) return null;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={
          <Space size={10} wrap>
            <Link to="/jobs">
              <ArrowLeftOutlined /> 任务列表
            </Link>
            <Typography.Text strong>任务 {job.jobId}</Typography.Text>
            <StatusTag status={job.status} />
            <Tag color={stream.connected ? "green" : "default"}>{stream.connected ? "事件流已连接" : "事件流未连接"}</Tag>
          </Space>
        }
        extra={
          <Space size={8} wrap>
            <Select<PhaseName>
              size="small"
              value={rerunPhase}
              style={{ width: 190 }}
              onChange={setRerunPhase}
              options={order.map((p) => ({ value: p, label: `重跑：${PHASE_LABEL[p]}` }))}
            />
            <Button size="small" icon={<RedoOutlined />} loading={busy} onClick={() => void doRerun()}>
              执行重跑
            </Button>
            <Popconfirm title="确认取消该任务？" onConfirm={() => void doCancel()}>
              <Button size="small" danger icon={<StopOutlined />} loading={busy}>
                取消
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <Row gutter={[16, 12]}>
          <Col xs={24} lg={10}>
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                当前阶段：{currentPhase ? PHASE_LABEL[currentPhase] : "—"}
              </Typography.Text>
              <Progress
                percent={percent}
                status={job.status === "failed" ? "exception" : job.status === "succeeded" ? "success" : undefined}
              />
            </Space>
          </Col>
          <Col xs={12} lg={4}>
            <Statistic title="成本" value={Number(usage?.cost?.amount ?? 0)} precision={4} prefix="¥" valueStyle={{ fontSize: 18 }} />
          </Col>
          <Col xs={12} lg={4}>
            <Statistic title="模型调用" value={usage?.tokens?.calls ?? 0} valueStyle={{ fontSize: 18 }} />
          </Col>
          <Col xs={12} lg={3}>
            <Statistic title="输入 token" value={usage?.tokens?.inputTokens ?? 0} valueStyle={{ fontSize: 18 }} />
          </Col>
          <Col xs={12} lg={3}>
            <Statistic title="输出 token" value={usage?.tokens?.outputTokens ?? 0} valueStyle={{ fontSize: 18 }} />
          </Col>
        </Row>

        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 4 }}
          style={{ marginTop: 14 }}
          items={[
            { key: "industry", label: "行业/类目", children: `${job.spec?.brief?.industry} / ${job.spec?.brief?.category}` },
            { key: "brands", label: "品牌", children: (job.spec?.brief?.brandIds ?? []).join("、") || "—" },
            {
              key: "budget",
              label: "预算",
              children: `¥${Number(job.spec?.brief?.budget?.amount ?? 0).toLocaleString("zh-CN")}`,
            },
            { key: "platforms", label: "平台", children: (job.spec?.brief?.platforms ?? []).join(" / ") || "—" },
            {
              key: "window",
              label: "时间窗口",
              children: `${job.spec?.brief?.window?.from ?? "—"} → ${job.spec?.brief?.window?.to ?? "—"}`,
            },
            {
              key: "weights",
              label: "目标权重",
              children: job.spec?.brief?.objectiveWeights
                ? `认知 ${job.spec.brief.objectiveWeights.awareness} / 转化 ${job.spec.brief.objectiveWeights.conversion} / 留存 ${job.spec.brief.objectiveWeights.retention}`
                : "—",
            },
            { key: "createdAt", label: "创建时间", children: clock(job.createdAt) },
            { key: "finishedAt", label: "结束时间", children: clock(job.finishedAt) },
          ]}
        />

        {job.spec?.brief?.notes ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 8, marginBottom: 0 }}>
            补充说明：{job.spec.brief.notes}
          </Typography.Paragraph>
        ) : null}

        {job.degraded?.length ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message={`降级与缺失（${job.degraded.length} 项）`}
            description={
              <Space direction="vertical" size={2}>
                {job.degraded.map((d, i) => (
                  <Typography.Text key={i} style={{ fontSize: 12 }}>
                    [{DEGRADE_LABEL[d.reason] ?? d.reason}] {d.note ?? ""}
                    {d.missing?.length ? `（${d.missing.slice(0, 4).join(" | ")}）` : ""}
                  </Typography.Text>
                ))}
              </Space>
            }
          />
        ) : null}

        {stream.error ? (
          <Alert type="error" showIcon style={{ marginTop: 12 }} message={`事件流中断：${stream.error}`} description="已自动重连，重连后仅补齐缺口事件。" />
        ) : null}
      </Card>

      <Card size="small" title="六阶段">
        <PhaseBoard phases={phases} order={order} />
      </Card>

      <Card size="small">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: "events",
              label: "实时事件流",
              children: (
                <Space direction="vertical" size={14} style={{ width: "100%" }}>
                  <LiveConsole messages={stream.live} deltaCount={stream.deltaCount} />
                  <EventTerminal
                    entries={stream.log}
                    follow={followLog}
                    onFollowChange={setFollowLog}
                    onClear={stream.clear}
                  />
                </Space>
              ),
            },
            {
              key: "report",
              label: "报告预览",
              children: tab === "report" ? (
                <ReportPreview jobId={jobId} refreshKey={reportTick} />
              ) : (
                <div style={{ height: 240 }} />
              ),
            },
            {
              key: "artifacts",
              label: "产物",
              children: <ArtifactPanel jobId={jobId} refreshKey={artifactTick} onOpenReport={() => setTab("report")} />,
            },
            {
              key: "ledger",
              label: "治理台账",
              children: (
                <Table<LedgerEntry>
                  size="small"
                  rowKey="ledgerId"
                  dataSource={ledger}
                  columns={ledgerColumns}
                  pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无台账记录" /> }}
                />
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
