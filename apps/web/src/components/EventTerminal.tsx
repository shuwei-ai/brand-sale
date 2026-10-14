import { useEffect, useRef } from "react";
import { Button, Space, Switch, Typography } from "antd";
import { ClearOutlined } from "@ant-design/icons";
import type { LogEntry } from "../hooks/useJobStream.ts";

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toTimeString().slice(0, 8);
};

/**
 * 事件流终端。
 *
 * 定位是"可追溯"而不是"可阅读"：这里逐条列出原始事件，
 * 包括降级（黄色）与治理拦截（红色）。`governance.block` 是合规硬要求——
 * 事件协议里明确规定它**不得静默**，所以它不进"可折叠的详情"，直接红字顶在最前面。
 */
export function EventTerminal({
  entries,
  onClear,
  follow,
  onFollowChange,
  height = 300,
}: {
  entries: LogEntry[];
  onClear?: () => void;
  follow: boolean;
  onFollowChange: (v: boolean) => void;
  height?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !follow) return;
    box.scrollTop = box.scrollHeight;
  }, [entries, follow]);

  return (
    <div>
      <Space size={10} style={{ marginBottom: 8 }} wrap>
        <Switch
          size="small"
          checked={follow}
          onChange={onFollowChange}
          checkedChildren="跟随"
          unCheckedChildren="暂停"
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {entries.length} 条事件（保留最近 400 条）
        </Typography.Text>
        {onClear ? (
          <Button size="small" type="text" icon={<ClearOutlined />} onClick={onClear}>
            清屏
          </Button>
        ) : null}
      </Space>

      <div className="bm-terminal">
        <div className="bm-term-bar">
          <i />
          <i />
          <i />
          <span>events · 实时事件流</span>
        </div>
        <div className="bm-events" ref={boxRef} style={{ height }}>
          {entries.length === 0 ? (
            <div style={{ color: "#5b6a7d" }}>暂无事件</div>
          ) : (
            entries.map((e, i) => (
              <div className={`bm-row ${e.level === "info" ? "" : e.level}`} key={`${e.seq}-${i}`}>
                <span className="bm-t">{clock(e.at)}</span>
                <span className="bm-k">{e.tag}</span>
                <span className="bm-v">{e.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
