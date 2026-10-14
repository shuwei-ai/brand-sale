import { useEffect, useRef, useState } from "react";
import { Button, Empty, Space, Switch, Tag, Typography } from "antd";
import { VerticalAlignBottomOutlined } from "@ant-design/icons";
import type { LiveMessage } from "../hooks/useJobStream.ts";

const KIND_COLOR: Record<LiveMessage["kind"], string> = {
  text: "blue",
  thinking: "purple",
  tool: "geekblue",
};

/**
 * 模型流式回显。
 *
 * 两个交互细节值得说明：
 *  ① **只在贴底时才自动跟随**。用户向上翻阅历史时被强行拽回底部是最恼人的体验，
 *     所以先判断"当前是否在底部 48px 内"，是才滚。
 *  ② 每条消息不截断高度（整块区域可滚动），因为报告类正文里
 *     中间被截掉的往往正是关键数字。
 */
export function LiveConsole({ messages, deltaCount }: { messages: LiveMessage[]; deltaCount: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !follow) return;
    box.scrollTop = box.scrollHeight;
  }, [messages, follow]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    if (atBottom !== follow) setFollow(atBottom);
  };

  return (
    <div>
      <Space size={10} style={{ marginBottom: 8 }} wrap>
        <Switch size="small" checked={follow} onChange={setFollow} checkedChildren="跟随" unCheckedChildren="暂停" />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          本次连接已接收 {deltaCount.toLocaleString("zh-CN")} 字符流式增量
        </Typography.Text>
        <Button
          size="small"
          type="text"
          icon={<VerticalAlignBottomOutlined />}
          onClick={() => {
            setFollow(true);
            const box = boxRef.current;
            if (box) box.scrollTop = box.scrollHeight;
          }}
        >
          回到底部
        </Button>
      </Space>

      <div className="bm-live" ref={boxRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span style={{ fontSize: 12 }}>等待模型输出…</span>}
            style={{ margin: "auto" }}
          />
        ) : (
          messages.map((m) => (
            <div className="bm-live-item" key={m.key}>
              <div className="bm-who">
                <Tag color={KIND_COLOR[m.kind]} style={{ marginInlineEnd: 6, fontSize: 10, lineHeight: "16px" }}>
                  {m.kind === "tool" ? "工具" : m.kind === "thinking" ? "推理" : "正文"}
                </Tag>
                {m.who}
              </div>
              <div className="bm-text">{m.text}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
