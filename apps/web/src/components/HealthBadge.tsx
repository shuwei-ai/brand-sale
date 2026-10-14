import { useCallback } from "react";
import { Tag, Tooltip } from "antd";
import { api } from "../api/endpoints.ts";
import { useAsync, usePolling } from "../hooks/useAsync.ts";

/**
 * 模型端点健康指示。
 *
 * 这个角标存在的理由：mock 模式与 live 模式的界面完全一样，
 * 但产出质量天差地别。把"当前离线桩模式"明明白白写在顶栏上，
 * 避免有人拿 mock 的确定性输出当真实结论。
 */
export function HealthBadge() {
  const { data, error, reload } = useAsync((signal) => api.health(signal), []);
  usePolling(reload, 30_000, true);

  const describe = useCallback((): { color: string; text: string; tip: string } => {
    if (error) return { color: "error", text: "健康检查失败", tip: error.display };
    if (!data) return { color: "default", text: "正在探测端点…", tip: "" };
    const llm = data.llm;
    const tip = [`模式 ${llm.mode}`, `端点 ${llm.baseUrl || "—"}`, `模型 ${llm.model || "—"}`, `环境 ${data.env}`].join("\n");
    if (llm.mode === "mock") return { color: "default", text: "离线桩模式（mock）", tip: tip + "\n确定性输出，非真实模型" };
    if (llm.ok) return { color: "success", text: `端点可用 · ${llm.model} · ${llm.models.length} 个模型`, tip };
    return { color: "error", text: `端点不可用：${llm.error ?? "未知错误"}`, tip };
  }, [data, error]);

  const d = describe();
  return (
    <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{d.tip}</span>}>
      <Tag color={d.color} style={{ cursor: "help", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>
        {d.text}
      </Tag>
    </Tooltip>
  );
}
