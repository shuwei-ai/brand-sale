import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Empty, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, UserOutlined } from "@ant-design/icons";
import { api } from "../api/endpoints.ts";
import type { AuthSessionRecord, AuthUser } from "../api/types.ts";
import { getLoggedInUser } from "../api/session.ts";

/**
 * 登录管理界面。
 *
 * 展示当前租户下：通过 DreamAuth 扫码登录过的**用户**（账号清单）与
 * 每次扫码的**会话记录**（登录历史）。数据来自网关 `/auth/users`（需鉴权）。
 *
 * 定位是「管理面」而非「登录面」：登录在独立的 LoginPage 完成，这里只管查看。
 */

const SESSION_STATUS: Record<number, { label: string; color: string }> = {
  1: { label: "待扫码", color: "default" },
  2: { label: "已扫码待确认", color: "processing" },
  3: { label: "已授权", color: "success" },
  4: { label: "已取消", color: "default" },
  6: { label: "已消费", color: "blue" },
  7: { label: "已过期", color: "warning" },
};

const clock = (v: string | null): string => {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
};

export function AuthPage() {
  const { message } = App.useApp();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [sessions, setSessions] = useState<AuthSessionRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const me = getLoggedInUser();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.authUsers();
      setUsers(res.users);
      setSessions(res.sessions);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  const userColumns: ColumnsType<AuthUser> = [
    {
      title: "用户",
      dataIndex: "nickname",
      render: (_: unknown, r) => (
        <span>
          <UserOutlined style={{ color: "#8a92a6", marginRight: 8 }} />
          <Typography.Text strong>{r.nickname ?? "微信用户"}</Typography.Text>
          {r.userId === me?.userId ? <Tag style={{ marginLeft: 8 }} color="blue">当前</Tag> : null}
        </span>
      ),
    },
    { title: "用户 ID", dataIndex: "userId", render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    {
      title: "微信身份",
      dataIndex: "openid",
      ellipsis: true,
      render: (v: string) => <Typography.Text type="secondary" style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{v}</Typography.Text>,
    },
    { title: "首次登录", dataIndex: "createdAt", width: 180, render: clock },
    { title: "最近登录", dataIndex: "lastLoginAt", width: 180, render: clock },
  ];

  const sessionColumns: ColumnsType<AuthSessionRecord> = [
    {
      title: "会话",
      dataIndex: "sessionNo",
      ellipsis: true,
      render: (v: string) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (v: number) => {
        const s = SESSION_STATUS[v] ?? { label: String(v), color: "default" };
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: "用户",
      dataIndex: "nickname",
      render: (_: unknown, r) => (r.nickname ? r.nickname : r.openid ? <Typography.Text type="secondary" style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{r.openid}</Typography.Text> : "—"),
    },
    { title: "创建时间", dataIndex: "createdAt", width: 180, render: clock },
    { title: "消费时间", dataIndex: "consumedAt", width: 180, render: clock },
    { title: "过期时间", dataIndex: "expireAt", width: 180, render: clock },
  ];

  return (
    <div style={{ maxWidth: 1080 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            登录管理
          </Typography.Title>
          <Typography.Text type="secondary">
            通过微信「DreamAuth」扫码登录的用户与会话记录
          </Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新
        </Button>
      </div>

      <Card
        title="已登录用户"
        size="small"
        style={{ marginBottom: 16 }}
        extra={<Typography.Text type="secondary">{users.length} 个账号</Typography.Text>}
      >
        <Table<AuthUser>
          rowKey="userId"
          size="small"
          columns={userColumns}
          dataSource={users}
          loading={loading}
          pagination={false}
          locale={{ emptyText: <Empty description="还没有用户登录过" /> }}
        />
      </Card>

      <Card
        title="扫码会话记录"
        size="small"
        extra={<Typography.Text type="secondary">{sessions.length} 条记录</Typography.Text>}
      >
        <Table<AuthSessionRecord>
          rowKey="sessionNo"
          size="small"
          columns={sessionColumns}
          dataSource={sessions}
          loading={loading}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty description="暂无扫码记录" /> }}
        />
      </Card>
    </div>
  );
}
