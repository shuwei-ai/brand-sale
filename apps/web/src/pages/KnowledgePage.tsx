import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  GLOBAL_WRITABLE_COLLECTIONS,
  KB_COLLECTIONS,
  KB_LABEL,
  type KbCollection,
} from "@brandsale/contracts";
import { api } from "../api/endpoints.ts";
import type { KbDocument, KbRetrieveResponse, SourceWithAuthz } from "../api/types.ts";
import { useAsync } from "../hooks/useAsync.ts";

interface IngestForm {
  title: string;
  collection: KbCollection;
  sourceId: string;
  publishedAt: dayjs.Dayjs;
  content: string;
  sampleSize?: number;
  humanVerified?: boolean;
  global?: boolean;
}

export function KnowledgePage() {
  const { message } = App.useApp();
  const [tab, setTab] = useState("documents");
  const [form] = Form.useForm<IngestForm>();
  const [submitting, setSubmitting] = useState(false);

  const [query, setQuery] = useState("");
  const [retrieveCollections, setRetrieveCollections] = useState<KbCollection[]>([]);
  const [retrieving, setRetrieving] = useState(false);
  const [retrieval, setRetrieval] = useState<KbRetrieveResponse | null>(null);

  const sources = useAsync((_signal) => api.listSources(), []);
  const stats = useAsync((_signal) => api.kbStats(), []);
  const docs = useAsync((_signal) => api.kbDocuments(), []);

  const sourceOptions = (sources.data?.items ?? []).map((s: SourceWithAuthz) => ({
    value: s.sourceId,
    label: `${s.name} · ${s.tier}${s.authz ? "" : "（无授权）"}`,
    disabled: !s.authz,
  }));

  const submit = async (v: IngestForm) => {
    setSubmitting(true);
    try {
      const r = await api.kbIngest({
        title: v.title.trim(),
        collection: v.collection,
        sourceId: v.sourceId,
        mime: "text/markdown",
        content: v.content,
        publishedAt: v.publishedAt.toISOString(),
        ...(v.sampleSize !== undefined && v.sampleSize !== null ? { sampleSize: v.sampleSize } : {}),
        ...(v.humanVerified !== undefined ? { humanVerified: v.humanVerified } : {}),
        ...(v.global ? { global: true } : {}),
      });
      message.success(`${r.replaced ? "已覆盖既有文档" : "入库成功"}：${r.chunks} 个知识块（解析器 ${r.parser}）`);
      form.setFieldsValue({ content: "", title: "" } as never);
      docs.reload();
      stats.reload();
    } catch (e) {
      // 失败原因可解释：来源未登记/未授权 → E-INGEST-001；格式不支持 → E-INGEST-002
      message.error((e as { display?: string })?.display ?? "入库失败");
    } finally {
      setSubmitting(false);
    }
  };

  const doRetrieve = async () => {
    if (!query.trim()) {
      message.warning("请输入检索语句");
      return;
    }
    setRetrieving(true);
    try {
      const r = await api.kbRetrieve({
        query: query.trim(),
        ...(retrieveCollections.length ? { collections: retrieveCollections } : {}),
        topK: 6,
      });
      setRetrieval(r);
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "检索失败");
    } finally {
      setRetrieving(false);
    }
  };

  const remove = async (docId: string) => {
    try {
      const r = await api.kbDelete(docId);
      message.success(`已删除文档及其 ${r.removedChunks} 个知识块`);
      docs.reload();
      stats.reload();
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "删除失败");
    }
  };

  const docColumns: ColumnsType<KbDocument> = [
    {
      title: "库",
      dataIndex: "collection",
      width: 90,
      render: (c: KbCollection) => <Tag color="blue">{c}</Tag>,
    },
    {
      title: "标题",
      dataIndex: "title",
      render: (t: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12.5 }}>{t}</Typography.Text>
          <Typography.Text type="secondary" className="bm-mono" style={{ fontSize: 11 }}>
            {row.docId} · {row.mime} · {row.byteSize} B
          </Typography.Text>
        </Space>
      ),
    },
    { title: "来源", dataIndex: "sourceId", width: 160, render: (s: string) => <span className="bm-mono" style={{ fontSize: 12 }}>{s}</span> },
    { title: "知识块", dataIndex: "chunkCount", width: 80 },
    {
      title: "入库时间",
      dataIndex: "ingestedAt",
      width: 170,
      render: (v: string) => new Date(v).toLocaleString("zh-CN", { hour12: false }),
    },
    {
      title: "操作",
      width: 80,
      render: (_: unknown, row) => (
        <Popconfirm title="确认删除该文档及其全部知识块？" onConfirm={() => void remove(row.docId)}>
          <Button size="small" type="link" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  const statsItems = stats.data?.items ?? [];

  return (
    <Card
      title="知识库"
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => {
            docs.reload();
            stats.reload();
            sources.reload();
          }}
          loading={docs.loading || stats.loading}
        >
          刷新
        </Button>
      }
    >
      <Row gutter={[12, 12]} style={{ marginBottom: 8 }}>
        {statsItems.length === 0 ? (
          <Col span={24}>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              知识库暂无内容。先往下面「入库」页签放一份行业情报或方法论。
            </Typography.Text>
          </Col>
        ) : (
          statsItems.map((s) => (
            <Col key={`${s.collection}-${s.scope}`} xs={12} md={8} xl={6}>
              <Card size="small" styles={{ body: { padding: "10px 14px" } }}>
                <Statistic
                  title={
                    <Space size={6}>
                      <span style={{ fontSize: 12 }}>{KB_LABEL[s.collection] ?? s.collection}</span>
                      <Tag style={{ fontSize: 10 }} color={s.scope === "global" ? "purple" : "default"}>
                        {s.scope === "global" ? "全局共享" : "租户私有"}
                      </Tag>
                    </Space>
                  }
                  value={s.chunks}
                  suffix="块"
                  valueStyle={{ fontSize: 20 }}
                />
              </Card>
            </Col>
          ))
        )}
      </Row>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "documents",
            label: `文档（${docs.data?.items.length ?? 0}）`,
            children: (
              <Table<KbDocument>
                size="small"
                rowKey="docId"
                loading={docs.loading}
                dataSource={docs.data?.items ?? []}
                columns={docColumns}
                pagination={{ pageSize: 12, hideOnSinglePage: true, showSizeChanger: false }}
                locale={{
                  emptyText: (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={docs.error?.display ?? "知识库暂无文档"} />
                  ),
                }}
              />
            ),
          },
          {
            key: "ingest",
            label: "入库",
            children: (
              <Row gutter={[16, 16]}>
                <Col xs={24} xl={15}>
                  <Form<IngestForm>
                    form={form}
                    layout="vertical"
                    initialValues={{
                      collection: "KB-3" as KbCollection,
                      publishedAt: dayjs(),
                      humanVerified: false,
                      global: false,
                    }}
                    onFinish={(v) => void submit(v)}
                  >
                    <Row gutter={12}>
                      <Col span={12}>
                        <Form.Item name="collection" label="归入知识库" rules={[{ required: true }]}>
                          <Select
                            options={KB_COLLECTIONS.map((c) => ({ value: c, label: `${c} ${KB_LABEL[c]}` }))}
                          />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="sourceId"
                          label="数据来源"
                          rules={[{ required: true, message: "请选择已在台账登记且授权有效的来源" }]}
                          extra="未登记或授权过期的来源会被网关拒绝（E-INGEST-001）"
                        >
                          <Select
                            showSearch
                            optionFilterProp="label"
                            placeholder={sources.loading ? "加载中…" : "选择来源"}
                            options={sourceOptions}
                            notFoundContent="台账暂无可用来源"
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="title" label="标题" rules={[{ required: true, message: "请填写标题" }]}>
                      <Input placeholder="如：2026 Q3 美妆行业公开情报" />
                    </Form.Item>
                    <Row gutter={12}>
                      <Col span={8}>
                        <Form.Item name="publishedAt" label="数据时点" rules={[{ required: true }]}>
                          <DatePicker style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="sampleSize" label="样本量" extra="不填则由正文自动提取">
                          <InputNumber min={0} style={{ width: "100%" }} />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="humanVerified" label="人工核验" valuePropName="checked">
                          <Switch checkedChildren="已核验" unCheckedChildren="未核验" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item
                      name="global"
                      label="写入跨租户共享语料"
                      valuePropName="checked"
                      extra={`仅 ${GLOBAL_WRITABLE_COLLECTIONS.join(" / ")} 这类公开情报与方法论允许；另有部署级开关 BM_KB_ALLOW_GLOBAL_WRITE`}
                    >
                      <Switch checkedChildren="共享" unCheckedChildren="仅本租户" />
                    </Form.Item>
                    <Form.Item
                      name="content"
                      label="正文（纯文本 / Markdown）"
                      rules={[{ required: true, message: "正文不能为空" }]}
                      extra="用 # 标题与空行分章可明显提升检索命中率"
                    >
                      <Input.TextArea rows={9} placeholder={"# 一、类目大盘\n\n正文……"} />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={submitting}>
                      入库
                    </Button>
                  </Form>
                </Col>
                <Col xs={24} xl={9}>
                  <Alert
                    type="info"
                    showIcon
                    message="为什么入库要卡来源"
                    description={
                      <Space direction="vertical" size={6} style={{ fontSize: 12.5 }}>
                        <Typography.Text>
                          报告会引用知识库内容并标注来源，所以"来源可追溯"是硬要求：
                          台账未登记、授权过期、L4 未经法务批准的来源，一律在写入前被拦下，
                          而不是先写进去再在报告里补一个来源名。
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          覆盖同名文档会整篇替换（连同旧知识块），不会留下两版并存。
                        </Typography.Text>
                      </Space>
                    }
                  />
                </Col>
              </Row>
            ),
          },
          {
            key: "retrieve",
            label: "检索测试",
            children: (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Space wrap>
                  <Input
                    style={{ width: 380 }}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onPressEnter={() => void doRetrieve()}
                    placeholder="如：精华类目大促期间的声量份额与竞品格局"
                  />
                  <Select
                    mode="multiple"
                    allowClear
                    style={{ minWidth: 260 }}
                    placeholder="限定知识库（默认全部）"
                    value={retrieveCollections}
                    onChange={setRetrieveCollections}
                    options={KB_COLLECTIONS.map((c) => ({ value: c, label: `${c} ${KB_LABEL[c]}` }))}
                  />
                  <Button type="primary" icon={<SearchOutlined />} loading={retrieving} onClick={() => void doRetrieve()}>
                    检索
                  </Button>
                </Space>

                {retrieval ? (
                  <>
                    <Space size={8}>
                      <Tag color={retrieval.reranked ? "green" : "default"}>
                        {retrieval.reranked ? "已重排" : "未重排（直出向量召回）"}
                      </Tag>
                      {retrieval.degraded ? (
                        <Tag color="orange">降级：{retrieval.degraded.reason}</Tag>
                      ) : null}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        命中 {retrieval.hits.length} 条
                      </Typography.Text>
                    </Space>
                    {retrieval.hits.length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有命中" />
                    ) : (
                      retrieval.hits.map((h) => (
                        <Card key={h.chunkId} size="small">
                          <Space size={8} style={{ marginBottom: 6 }}>
                            <Tag color="blue">{h.collection}</Tag>
                            <Typography.Text type="secondary" className="bm-mono" style={{ fontSize: 11 }}>
                              score {h.score.toFixed(4)}
                              {typeof h.rerankScore === "number" ? ` · rerank ${h.rerankScore.toFixed(4)}` : ""}
                            </Typography.Text>
                          </Space>
                          <Typography.Paragraph style={{ fontSize: 12.5, marginBottom: 0 }}>
                            {h.text}
                          </Typography.Paragraph>
                        </Card>
                      ))
                    )}
                  </>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    检索走的是报告生成时同一套通道，用来验证"甲方资料是否真的能被召回"。
                  </Typography.Text>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
