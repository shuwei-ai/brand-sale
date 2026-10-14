import { useEffect, useState, useSyncExternalStore } from "react";
import { App, Button, Input, Space, Tooltip, Typography } from "antd";
import { KeyOutlined } from "@ant-design/icons";
import { getToken, parseTenant, setToken, subscribeToken } from "../api/session.ts";

/**
 * 令牌输入框。
 *
 * 用 useSyncExternalStore 订阅模块级会话 store，而不是把 token 放进 Context：
 * 令牌是**数据层**要用的（每个 fetch 都贴），不是组件树要用的，
 * 用 Context 会把它变成"必须透传的东西"。
 */
export function TokenBox() {
  const { message } = App.useApp();
  const token = useSyncExternalStore(subscribeToken, getToken, getToken);
  const [draft, setDraft] = useState(token);

  // 外部（如"保存"后）令牌变化时同步输入框，避免显示与实际不一致
  useEffect(() => setDraft(token), [token]);

  const tenant = parseTenant(token);
  const invalid = !tenant;

  const commit = () => {
    setToken(draft);
    message.success("令牌已保存，正在刷新");
  };

  return (
    <Space size={6}>
      <Tooltip
        title={
          invalid
            ? "格式应为 t.<tenantId>.<userId>"
            : `租户 ${tenant?.tenantId} · 用户 ${tenant?.userId}`
        }
      >
        <Input
          size="small"
          style={{ width: 210 }}
          value={draft}
          status={invalid ? "error" : undefined}
          prefix={<KeyOutlined style={{ color: "#8a92a6" }} />}
          placeholder="t.<tenantId>.<userId>"
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={commit}
        />
      </Tooltip>
      <Button size="small" onClick={commit}>
        保存
      </Button>
      {invalid ? (
        <Typography.Text type="danger" style={{ fontSize: 11 }}>
          令牌格式非法
        </Typography.Text>
      ) : null}
    </Space>
  );
}
