import { useState } from "react";
import { App, Button, Drawer, Empty, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DownloadOutlined, EyeOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/endpoints.ts";
import type { ArtifactListItem } from "../api/types.ts";
import { useAsync } from "../hooks/useAsync.ts";
import { extensionOf, prettyJson, saveBlob } from "../utils/download.ts";

/** 9 类产物的中文名。后端加产物类型时这里补一行即可，未登记的类型显示原码。 */
const ARTIFACT_LABEL: Record<string, string> = {
  brief: "Brief（录入规格）",
  intel: "情报分析",
  intel_evidence: "平台采集证据（溯源）",
  creator_candidates: "达人候选",
  playbook: "打法与排期",
  budget: "预算与风控",
  report_dsl: "报告 DSL",
  report_markdown: "报告 Markdown",
  report_html: "报告 HTML",
};

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
};

/**
 * 产物面板。
 *
 * 列表接口刻意**不回传 inline**（report_dsl 可达数十 KB，一次列 8 个会让
 * 响应体膨胀到几百 KB），所以内容按需走 `GET /jobs/:id/artifacts/:kind` 单取。
 */
export function ArtifactPanel({
  jobId,
  refreshKey,
  onOpenReport,
}: {
  jobId: string;
  refreshKey: number;
  onOpenReport: () => void;
}) {
  const { message } = App.useApp();
  const { data, loading, error, reload } = useAsync((_signal) => api.listArtifacts(jobId), [jobId, refreshKey]);
  const [drawer, setDrawer] = useState<{ kind: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const items = data?.items ?? [];

  const fetchOne = async (kind: string): Promise<string> => api.getArtifactText(jobId, kind as never);

  const preview = async (kind: string) => {
    if (kind === "report_html") {
      onOpenReport();
      return;
    }
    setBusy(kind);
    try {
      const text = await fetchOne(kind);
      setDrawer({ kind, text });
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "预览失败");
    } finally {
      setBusy(null);
    }
  };

  const download = async (kind: string) => {
    setBusy(kind);
    try {
      const text = await fetchOne(kind);
      saveBlob(prettyJson(text), `${kind}-${jobId}.${extensionOf(kind)}`);
      message.success(`已下载 ${kind}`);
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "下载失败");
    } finally {
      setBusy(null);
    }
  };

  const columns: ColumnsType<ArtifactListItem> = [
    {
      title: "产物",
      dataIndex: "kind",
      render: (kind: string) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong style={{ fontSize: 12.5 }}>
            {ARTIFACT_LABEL[kind] ?? kind}
          </Typography.Text>
          <Typography.Text type="secondary" className="bm-mono" style={{ fontSize: 11 }}>
            {kind}
          </Typography.Text>
        </Space>
      ),
    },
    { title: "生成时间", dataIndex: "createdAt", width: 190, render: (v: string) => clock(v) },
    {
      title: "操作",
      width: 200,
      render: (_: unknown, row) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            icon={<EyeOutlined />}
            loading={busy === row.kind}
            onClick={() => void preview(row.kind)}
          >
            预览
          </Button>
          <Button
            size="small"
            type="link"
            icon={<DownloadOutlined />}
            loading={busy === row.kind}
            onClick={() => void download(row.kind)}
          >
            下载
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 10 }}>
        <Button size="small" icon={<ReloadOutlined />} onClick={reload} loading={loading}>
          刷新产物
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {items.length} 项
        </Typography.Text>
      </Space>

      <Table<ArtifactListItem>
        size="small"
        rowKey="artifactId"
        loading={loading}
        dataSource={items}
        columns={columns}
        pagination={false}
        locale={{
          emptyText: error ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error.display} />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无产物" />
          ),
        }}
      />

      <Drawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        width="min(920px, 92vw)"
        title={drawer ? `${ARTIFACT_LABEL[drawer.kind] ?? drawer.kind}` : ""}
        extra={
          drawer ? (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => {
                saveBlob(prettyJson(drawer.text), `${drawer.kind}-${jobId}.${extensionOf(drawer.kind)}`);
              }}
            >
              下载
            </Button>
          ) : null
        }
      >
        {drawer ? <pre className="bm-code">{prettyJson(drawer.text)}</pre> : null}
      </Drawer>
    </div>
  );
}
