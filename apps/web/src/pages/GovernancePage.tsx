import { useState } from "react";
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined, SafetyOutlined } from "@ant-design/icons";
import { TIER_LABEL, type DataTier } from "@brandsale/contracts";
import { api } from "../api/endpoints.ts";
import type { AuditListItem, AuthzRecord, SourceWithAuthz } from "../api/types.ts";
import { useAsync } from "../hooks/useAsync.ts";

const TIERS: DataTier[] = ["L1", "L2", "L3", "L4"];

const clock = (iso?: string): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
};

const AUDIT_COLOR: Record<string, string> = {
  "gate.allow": "green",
  "gate.deny": "red",
  "gate.error": "orange",
  "source.register": "blue",
  "authz.grant": "cyan",
  "authz.revoke": "volcano",
  "kb.ingest": "geekblue",
  "kb.ingest.rejected": "red",
  "security.alert": "magenta",
};

export function GovernancePage() {
  const { message } = App.useApp();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regForm] = Form.useForm();
  const [grantForm] = Form.useForm();

  const sources = useAsync((_signal) => api.listSources(), []);
  const authz = useAsync((_signal) => api.listAuthz(), []);
  const audit = useAsync((_signal) => api.audit(80), []);

  const reloadAll = () => {
    sources.reload();
    authz.reload();
    audit.reload();
  };

  const doRegister = async () => {
    const v = await regForm.validateFields();
    setSaving(true);
    try {
      await api.registerSource({
        sourceId: v.sourceId,
        name: v.name,
        tier: v.tier,
        ...(v.owner ? { owner: v.owner } : {}),
        ...(v.authMethod ? { authMethod: v.authMethod } : {}),
        ...(v.contractRef ? { contractRef: v.contractRef } : {}),
        legalApproved: Boolean(v.legalApproved),
      });
      message.success(`数据源 ${v.sourceId} 已登记`);
      setRegisterOpen(false);
      regForm.resetFields();
      reloadAll();
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "登记失败");
    } finally {
      setSaving(false);
    }
  };

  const doGrant = async () => {
    const v = await grantForm.validateFields();
    setSaving(true);
    try {
      await api.grantAuthz({
        sourceId: v.sourceId,
        ...(v.grantedBy ? { grantedBy: v.grantedBy } : {}),
        days: v.days,
        scopes: v.scopes,
      });
      message.success(`已授权 ${v.sourceId}`);
      setGrantOpen(false);
      grantForm.resetFields();
      reloadAll();
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "授权失败");
    } finally {
      setSaving(false);
    }
  };

  const sourceColumns: ColumnsType<SourceWithAuthz> = [
    {
      title: "数据源",
      dataIndex: "sourceId",
      render: (id: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong className="bm-mono" style={{ fontSize: 12 }}>
            {id}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            {row.name}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "分级",
      dataIndex: "tier",
      width: 190,
      render: (t: DataTier) => <Tag color="blue">{TIER_LABEL[t] ?? t}</Tag>,
    },
    { title: "类型", dataIndex: "sourceType", width: 120, render: (v: string) => <span className="bm-mono" style={{ fontSize: 11.5 }}>{v}</span> },
    { title: "负责人", dataIndex: "owner", width: 110 },
    {
      title: "授权状态",
      width: 210,
      render: (_: unknown, row) =>
        row.authz ? (
          <Tooltip title={`${clock(row.authz.validFrom)} → ${clock(row.authz.validTo)}｜scopes: ${(row.authz.scopes ?? []).join(", ")}`}>
            <Tag color="green" style={{ cursor: "help" }}>
              有效 · 至 {row.authz.validTo.slice(0, 10)}
            </Tag>
          </Tooltip>
        ) : (
          <Space size={6}>
            <Tag color="default">无授权</Tag>
            <Button
              size="small"
              type="link"
              onClick={() => {
                grantForm.setFieldsValue({ sourceId: row.sourceId, days: 180, scopes: ["read"] });
                setGrantOpen(true);
              }}
            >
              去授权
            </Button>
          </Space>
        ),
    },
    {
      title: "法务批准",
      dataIndex: "legalApproved",
      width: 100,
      render: (v: boolean) => (v ? <Tag color="green">已批准</Tag> : <Tag>未批准</Tag>),
    },
    { title: "登记时间", dataIndex: "registeredAt", width: 170, render: (v: string) => clock(v) },
  ];

  const authzColumns: ColumnsType<AuthzRecord> = [
    { title: "授权 ID", dataIndex: "authzId", width: 200, render: (v: string) => <span className="bm-mono" style={{ fontSize: 11.5 }}>{v}</span> },
    { title: "数据源", dataIndex: "sourceId", width: 160, render: (v: string) => <span className="bm-mono" style={{ fontSize: 12 }}>{v}</span> },
    { title: "授权方", dataIndex: "grantedBy", width: 130 },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (s: string) => (
        <Tag color={s === "active" ? "green" : s === "expired" ? "orange" : "red"}>
          {s === "active" ? "有效" : s === "expired" ? "已过期" : "已撤销"}
        </Tag>
      ),
    },
    { title: "生效", dataIndex: "validFrom", width: 170, render: (v: string) => clock(v) },
    { title: "失效", dataIndex: "validTo", width: 170, render: (v: string) => clock(v) },
    { title: "范围", dataIndex: "scopes", width: 120, render: (s: string[]) => (s ?? []).join(", ") || "—" },
  ];

  const auditColumns: ColumnsType<AuditListItem> = [
    { title: "时间", dataIndex: "at", width: 170, render: (v: string) => clock(v) },
    {
      title: "类型",
      dataIndex: "kind",
      width: 150,
      render: (k: string) => <Tag color={AUDIT_COLOR[k] ?? "default"}>{k}</Tag>,
    },
    { title: "码", dataIndex: "code", width: 110, render: (v: string) => <span className="bm-mono" style={{ fontSize: 11.5 }}>{v}</span> },
    { title: "任务", dataIndex: "jobId", width: 160, render: (v?: string) => (v ? <span className="bm-mono" style={{ fontSize: 11 }}>{v.slice(0, 16)}…</span> : "—") },
    { title: "工具", dataIndex: "tool", width: 140, render: (v?: string) => v ?? "—" },
    {
      title: "说明",
      dataIndex: "reason",
      render: (v?: string) => <Typography.Text style={{ fontSize: 12 }}>{v ?? "—"}</Typography.Text>,
    },
  ];

  const summary = audit.data?.summary ?? {};

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title="数据源台账"
        extra={
          <Space>
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => {
                regForm.setFieldsValue({ tier: "L3", legalApproved: false });
                setRegisterOpen(true);
              }}
            >
              登记数据源
            </Button>
            <Button
              size="small"
              icon={<SafetyOutlined />}
              onClick={() => {
                grantForm.setFieldsValue({ days: 180, scopes: ["read"] });
                setGrantOpen(true);
              }}
            >
              新增授权
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={reloadAll} loading={sources.loading}>
              刷新
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
          「登记」只是把来源写进台账；<b>能被真正取用</b>还需要一条有效授权。
          两者都齐了，Agent 的工具才会在闸门处放行——缺授权时任务不会失败，
          而是降级并写进报告的排除项。
        </Typography.Paragraph>
        <Table<SourceWithAuthz>
          size="small"
          rowKey="sourceId"
          loading={sources.loading}
          dataSource={sources.data?.items ?? []}
          columns={sourceColumns}
          pagination={false}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={sources.error?.display ?? "台账暂无数据源"} />
            ),
          }}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={11}>
          <Card title="授权记录" size="small" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{authz.data?.items.length ?? 0} 条</Typography.Text>}>
            <Table<AuthzRecord>
              size="small"
              rowKey="authzId"
              loading={authz.loading}
              dataSource={authz.data?.items ?? []}
              columns={authzColumns}
              pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }}
              scroll={{ x: 820 }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无授权记录" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={13}>
          <Card
            title="审计"
            size="small"
            extra={
              <Space size={6} wrap>
                {Object.entries(summary).map(([k, n]) => (
                  <Tag key={k} color={AUDIT_COLOR[k] ?? "default"}>
                    {k} {n}
                  </Tag>
                ))}
              </Space>
            }
          >
            <Table<AuditListItem>
              size="small"
              rowKey="auditId"
              loading={audit.loading}
              dataSource={audit.data?.items ?? []}
              columns={auditColumns}
              pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无审计记录" /> }}
            />
          </Card>
        </Col>
      </Row>

      <Modal
        open={registerOpen}
        title="登记数据源"
        onCancel={() => setRegisterOpen(false)}
        onOk={() => void doRegister()}
        confirmLoading={saving}
        okText="登记"
        destroyOnClose
      >
        <Form form={regForm} layout="vertical">
          <Form.Item name="sourceId" label="数据源 ID" rules={[{ required: true, message: "请填写唯一 ID" }]}>
            <Input placeholder="如 volc_web_search / mc_xhs" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请填写名称" }]}>
            <Input placeholder="如 火山引擎联网搜索 Lite" />
          </Form.Item>
          <Form.Item name="tier" label="数据分级" rules={[{ required: true, message: "请选择分级" }]} extra="L4 需要合同出处与法务批准双开关">
            <Select options={TIERS.map((t) => ({ value: t, label: `${t} · ${TIER_LABEL[t]}` }))} />
          </Form.Item>
          <Form.Item name="owner" label="负责人">
            <Input placeholder="留空则记为当前用户" />
          </Form.Item>
          <Form.Item name="authMethod" label="授权方式">
            <Input placeholder="如 千川子账号 OAuth" />
          </Form.Item>
          <Form.Item name="contractRef" label="合同/授权出处">
            <Input placeholder="L4 建议填写" />
          </Form.Item>
          <Form.Item name="legalApproved" label="法务已批准" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={grantOpen}
        title="新增授权"
        onCancel={() => setGrantOpen(false)}
        onOk={() => void doGrant()}
        confirmLoading={saving}
        okText="授权"
        destroyOnClose
      >
        <Form form={grantForm} layout="vertical">
          <Form.Item name="sourceId" label="数据源" rules={[{ required: true, message: "请选择数据源" }]}>
            <Input placeholder="sourceId" />
          </Form.Item>
          <Form.Item name="grantedBy" label="授权方">
            <Input placeholder="客户方联系人或账号；留空记为当前用户" />
          </Form.Item>
          <Form.Item name="days" label="有效期（天）" rules={[{ required: true }]}>
            <InputNumber min={1} max={3650} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="scopes" label="授权范围">
            <Select mode="tags" placeholder="read（回车确认）" open={false} suffixIcon={null} tokenSeparators={[","]} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
