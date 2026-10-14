import { Tag } from "antd";
import { STATUS_COLOR, STATUS_LABEL } from "../theme.ts";

/**
 * 任务/阶段状态标签。
 *
 * 颜色与文案只在 theme.ts 里定义一份：状态码是后端契约的一部分，
 * 前端不该在任何页面里出现 `status === "partial" ? "橙" : ...` 这样的分支。
 */
export function StatusTag({ status }: { status: string }) {
  const running = status === "running" || status === "queued";
  return (
    <Tag color={STATUS_COLOR[status] ?? "default"} style={{ marginInlineEnd: 0 }}>
      <span className={running ? "bm-pulse" : undefined} style={{ fontWeight: 550 }}>
        {STATUS_LABEL[status] ?? status}
      </span>
    </Tag>
  );
}
