import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Space, Typography } from "antd";
import { DownloadOutlined, ExportOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/endpoints.ts";
import { htmlToObjectUrl, saveBlob } from "../utils/download.ts";

/**
 * 报告内嵌预览。
 *
 * 端点 `GET /jobs/:id/report` 要求鉴权，而 `<iframe src>` 带不了请求头，
 * 所以流程是「带 token fetch 成文本 → 造 blob URL → 喂 iframe」，
 * "在新标签打开"复用同一个 URL。绝不为了预览方便而给报告端点开匿名口子。
 *
 * 另外，这里**必须把"报告还没生成"和"渲染控件坏了"分开报**：
 * 前者是正常业务状态（任务还在跑），后者是真故障，混成一条文案就查不出问题。
 */
export function ReportPreview({
  jobId,
  refreshKey,
  autoLoad = false,
}: {
  jobId: string;
  refreshKey: number;
  autoLoad?: boolean;
}) {
  const { message } = App.useApp();
  const [html, setHtml] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<"idle" | "missing" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");
  const urlRef = useRef<string | null>(null);

  // 卸载时回收 blob，否则每刷一次报告就泄漏一份完整 HTML
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const load = async () => {
    setPending(true);
    try {
      const text = await api.getReportHtml(jobId);
      setHtml(text);
      setState("idle");
      try {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const next = htmlToObjectUrl(text);
        urlRef.current = next;
        setUrl(next);
      } catch (e) {
        // 宿主不支持 blob URL 时要如实说，而不是显示"报告未生成"
        setUrl(null);
        setErrMsg(e instanceof Error ? e.message : String(e));
      }
    } catch (e) {
      const isMissing = (e as { code?: string })?.code === "E-RENDER-002";
      setState(isMissing ? "missing" : "error");
      setErrMsg((e as { display?: string })?.display ?? (e instanceof Error ? e.message : String(e)));
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    if (!jobId) return;
    if (autoLoad || refreshKey > 0) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, refreshKey, autoLoad]);

  const download = () => {
    if (!html) return;
    saveBlob(html, `report-${jobId}.html`, "text/html;charset=utf-8");
    message.success("报告已开始下载");
  };

  if (state === "missing") {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span style={{ fontSize: 12.5 }}>
            报告尚未产出。任务执行到「研报生成与渲染」阶段后会自动出现。
          </span>
        }
        style={{ padding: "20px 0" }}
      >
        <Button size="small" icon={<ReloadOutlined />} loading={pending} onClick={load}>
          重新检查
        </Button>
      </Empty>
    );
  }

  return (
    <div>
      <Space size={8} style={{ marginBottom: 8 }} wrap>
        <Button size="small" icon={<ReloadOutlined />} loading={pending} onClick={load}>
          重新拉取
        </Button>
        <Button size="small" icon={<ExportOutlined />} disabled={!url} onClick={() => url && window.open(url, "_blank")}>
          在新标签打开
        </Button>
        <Button size="small" icon={<DownloadOutlined />} disabled={!html} onClick={download}>
          下载 HTML
        </Button>
        {html ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {html.length.toLocaleString("zh-CN")} 字符 · 由 M16 渲染模块产出
          </Typography.Text>
        ) : null}
      </Space>

      {state === "error" ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message="报告取回失败"
          description={errMsg}
        />
      ) : null}
      {html && !url ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="宿主不支持 blob URL，已改用 srcdoc 内嵌"
          description={errMsg}
        />
      ) : null}

      {html ? (
        url ? (
          <iframe className="bm-report-frame" src={url} title="报告预览" />
        ) : (
          <iframe className="bm-report-frame" srcDoc={html} title="报告预览" />
        )
      ) : (
        <Button size="small" onClick={load} loading={pending}>
          加载报告
        </Button>
      )}
    </div>
  );
}
