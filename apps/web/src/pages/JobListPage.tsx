import { useState } from "react";
import { App, Button, Card, Empty, Progress, Space, Switch, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { api } from "../api/endpoints.ts";
import type { JobRecord } from "../api/types.ts";
import { useAsync, usePolling } from "../hooks/useAsync.ts";
import { StatusTag } from "../components/StatusTag.tsx";

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
};

const pct = (job: JobRecord): number => Math.round((job.progress?.percent ?? 0) * 100);

export function JobListPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [auto, setAuto] = useState(true);
  const { data, loading, error, reload } = useAsync((_signal) => api.listJobs(30), []);
  usePolling(reload, 5000, auto);

  const jobs = data?.items ?? [];
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued").length;

  const recover = async () => {
    try {
      const r = await api.recover();
      message.success(`崩溃恢复扫描完成：${JSON.stringify(r)}`);
      reload();
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "扫描失败");
    }
  };

  const columns: ColumnsType<JobRecord> = [
    {
      title: "任务",
      dataIndex: "jobId",
      render: (jobId: string, row) => (
        <Space direction="vertical" size={0}>
          <Tooltip title={jobId}>
            <Typography.Text className="bm-mono" strong style={{ fontSize: 12 }}>
              {jobId.length > 22 ? `${jobId.slice(0, 14)}…${jobId.slice(-6)}` : jobId}
            </Typography.Text>
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            {row.spec?.brief?.industry} / {row.spec?.brief?.category}
          </Typography.Text>
        </Space>
      ),
    },
    { title: "状态", dataIndex: "status", width: 110, render: (s: string) => <StatusTag status={s} /> },
    {
      title: "进度",
      width: 190,
      render: (_: unknown, row) => (
        <Space direction="vertical" size={2} style={{ width: "100%" }}>
          <Progress percent={pct(row)} size="small" status={row.status === "failed" ? "exception" : undefined} />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            当前阶段：{row.progress?.currentPhase ?? "—"}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "平台",
      dataIndex: ["spec", "brief", "platforms"],
      width: 160,
      render: (list: string[]) => (
        <Typography.Text style={{ fontSize: 12 }}>{(list ?? []).join(" / ") || "—"}</Typography.Text>
      ),
    },
    {
      title: "预算",
      width: 110,
      render: (_: unknown, row) => (
        <Typography.Text style={{ fontSize: 12 }}>
          ¥{Number(row.spec?.brief?.budget?.amount ?? 0).toLocaleString("zh-CN")}
        </Typography.Text>
      ),
    },
    {
      title: "降级",
      width: 80,
      render: (_: unknown, row) =>
        row.degraded?.length ? (
          <Tooltip title={row.degraded.map((d) => `${d.reason}: ${d.note ?? ""}`).join("\n")}>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {row.degraded.length} 项
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ),
    },
    { title: "创建时间", dataIndex: "createdAt", width: 180, render: (v: string) => clock(v) },
    {
      title: "操作",
      width: 90,
      render: (_: unknown, row) => (
        <Button size="small" type="link" onClick={() => navigate(`/jobs/${row.jobId}`)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="任务列表"
      extra={
        <Space size={12}>
          <Space size={6}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              自动刷新
            </Typography.Text>
            <Switch size="small" checked={auto} onChange={setAuto} />
          </Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={reload} loading={loading}>
            刷新
          </Button>
          <Tooltip title="扫描遗留的 running 任务并重新入队">
            <Button size="small" icon={<SafetyCertificateOutlined />} onClick={() => void recover()}>
              崩溃恢复
            </Button>
          </Tooltip>
        </Space>
      }
    >
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
        共 {jobs.length} 个任务，其中进行中 {running} 个。
      </Typography.Text>
      <Table<JobRecord>
        size="small"
        rowKey="jobId"
        loading={loading}
        dataSource={jobs}
        columns={columns}
        pagination={{ pageSize: 15, hideOnSinglePage: true, showSizeChanger: false }}
        onRow={(row) => ({
          onClick: () => navigate(`/jobs/${row.jobId}`),
          style: { cursor: "pointer" },
        })}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={error ? error.display : "暂无任务，先去「新建任务」提交一个 Brief"}
            />
          ),
        }}
      />
    </Card>
  );
}
