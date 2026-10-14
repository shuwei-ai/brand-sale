import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { BulbOutlined, RocketOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate } from "react-router-dom";
import { POPULAR_PLATFORMS, type Brief, type Platform } from "@brandsale/contracts";
import { api, newIdempotencyKey } from "../api/endpoints.ts";
import type { BriefParseResponse } from "../api/types.ts";

const PLATFORM_LABEL: Record<Platform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  bilibili: "B 站",
  weibo: "微博",
};

interface FormValues {
  industry: string;
  category: string;
  brandIds: string[];
  budgetWan: number;
  awareness: number;
  conversion: number;
  retention: number;
  window: [Dayjs, Dayjs];
  platforms: Platform[];
  notes?: string;
}

const DEFAULTS: FormValues = {
  industry: "美妆",
  category: "护肤品-精华",
  brandIds: ["brand_A"],
  budgetWan: 300,
  awareness: 0.3,
  conversion: 0.5,
  retention: 0.2,
  window: [dayjs("2026-05-20"), dayjs("2026-06-20")],
  platforms: ["douyin", "xiaohongshu"],
  notes: "主打新品抗老精华，竞品锁定 X/Y",
};

/** 时间窗默认值：今天起 30 天。放函数里，避免模块加载时就固化住日期。 */
export const defaultWindow = (): [Dayjs, Dayjs] => [dayjs().startOf("day"), dayjs().startOf("day").add(30, "day")];

/** 三个目标权重求和。空值当 0 处理——"没填"就是"不合法"，不该被悄悄补成默认值。 */
const sumWeights = (v: Partial<FormValues>): number =>
  (Number(v.awareness) || 0) + (Number(v.conversion) || 0) + (Number(v.retention) || 0);

export function NewJobPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [utterance, setUtterance] = useState("");
  const [parseResult, setParseResult] = useState<BriefParseResponse | null>(null);
  /** 同一次录入意图复用一个幂等键：手抖点两下不会开出两个任务 */
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey());

  /**
   * 权重实时求和。
   *
   * 不用 `Form.useWatch(["awareness", ...])`：数组路径的 useWatch 在**首帧**
   * 拿不到 Form 的 initialValues，会算成 0，表现为"刚进页面合计 0.00、
   * 提交按钮就是灰的"，必须动一下输入框才恢复——这是个静默的可用性缺陷。
   * 这里改成「初值直接算 + onValuesChange 同步」的显式状态，行为完全确定。
   */
  const [weightSum, setWeightSum] = useState<number>(() => sumWeights(DEFAULTS));
  const sumOk = Math.abs(weightSum - 1) <= 0.051;
  const syncWeights = (values: Partial<FormValues>) => setWeightSum(sumWeights(values));

  // Form 实例挂载后才可读，首帧补一次同步（覆盖 initialValues 与浏览器表单恢复）
  useEffect(() => {
    syncWeights(form.getFieldsValue());
  }, [form]);

  /* ── 自然语言解析 → 回填表单 ─────────────────────────────
   * 刻意"回填"而不是"直接提交"：结构化字段仍是唯一提交契约，
   * 自然语言只是录入入口的糖。用户回填后能逐项改，改了就是他的意思。
   */
  const doParse = async () => {
    const text = utterance.trim();
    if (!text) {
      message.warning("请先用一句话描述诉求");
      return;
    }
    setParsing(true);
    try {
      const current = form.getFieldsValue();
      const r = await api.parseBrief(text, {
        industry: current.industry,
        category: current.category,
        budget: { currency: "CNY", amount: Math.round((current.budgetWan || 0) * 10_000) },
        window: current.window
          ? { from: current.window[0].format("YYYY-MM-DD"), to: current.window[1].format("YYYY-MM-DD") }
          : { from: dayjs().format("YYYY-MM-DD"), to: dayjs().add(30, "day").format("YYYY-MM-DD") },
      });
      setParseResult(r);

      const b = r.brief;
      const patch: Partial<FormValues> = {};
      if (b.industry) patch.industry = b.industry;
      if (b.category) patch.category = b.category;
      if (b.brandIds?.length) patch.brandIds = b.brandIds;
      if (typeof b.budget?.amount === "number") patch.budgetWan = Math.round(b.budget.amount / 10_000);
      if (b.objectiveWeights) {
        patch.awareness = b.objectiveWeights.awareness;
        patch.conversion = b.objectiveWeights.conversion;
        patch.retention = b.objectiveWeights.retention;
      }
      if (b.window) patch.window = [dayjs(b.window.from), dayjs(b.window.to)];
      if (b.platforms) {
        // 只接受系统支持的平台码，避免解析出平台之外的字符串把提交体弄脏
        const allowed = b.platforms.filter((p): p is Platform => (POPULAR_PLATFORMS as readonly string[]).includes(p));
        if (allowed.length) patch.platforms = allowed;
      }
      if (b.notes) patch.notes = b.notes;
      form.setFieldsValue(patch);
      // setFieldsValue 不一定触发 onValuesChange，这里显式同步一次权重合计
      syncWeights(form.getFieldsValue());
      message.success(`已回填 ${Object.keys(patch).length} 个字段，请核对后提交`);
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "解析失败");
    } finally {
      setParsing(false);
    }
  };

  const submit = async (values: FormValues) => {
    const w = {
      awareness: Number(values.awareness),
      conversion: Number(values.conversion),
      retention: Number(values.retention),
    };
    if (Math.abs(w.awareness + w.conversion + w.retention - 1) > 0.051) {
      message.error(`三个目标权重之和需为 1（当前 ${(w.awareness + w.conversion + w.retention).toFixed(2)}）`);
      return;
    }
    const brief: Brief = {
      industry: values.industry.trim(),
      category: values.category.trim(),
      brandIds: (values.brandIds ?? []).map((s) => s.trim()).filter(Boolean),
      budget: { currency: "CNY", amount: Math.round(Number(values.budgetWan) * 10_000) },
      objectiveWeights: w,
      window: { from: values.window[0].format("YYYY-MM-DD"), to: values.window[1].format("YYYY-MM-DD") },
      platforms: values.platforms,
      ...(values.notes ? { notes: values.notes.trim() } : {}),
    };

    setSubmitting(true);
    try {
      const out = await api.createJob(brief, idemKey);
      message.success(out.reused ? `命中幂等键，复用任务 ${out.job.jobId}` : `任务已创建：${out.job.jobId}`);
      // 下一次提交换一把新钥匙
      setIdemKey(newIdempotencyKey());
      navigate(`/jobs/${out.job.jobId}`);
    } catch (e) {
      message.error((e as { display?: string })?.display ?? "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}>
        <Card
          title="新建任务（Brief）"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              结构化字段是唯一提交契约
            </Typography.Text>
          }
        >
          <Alert
            type="info"
            showIcon
            icon={<BulbOutlined />}
            style={{ marginBottom: 14 }}
            message="一句话录入"
            description={
              <Space direction="vertical" style={{ width: "100%" }} size={8}>
                <Typography.Text style={{ fontSize: 12.5 }}>
                  用自然语言描述诉求，解析结果会<b>回填到下方表单</b>，你可以逐项修改后再提交。
                </Typography.Text>
                <Input.TextArea
                  rows={2}
                  value={utterance}
                  onChange={(e) => setUtterance(e.target.value)}
                  placeholder="例：双11 想在小红书和抖音做一波精华投放，预算 300 万，主要要曝光也要销量"
                />
                <Space>
                  <Button size="small" type="primary" ghost loading={parsing} onClick={() => void doParse()}>
                    解析并回填表单
                  </Button>
                  {parseResult ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      来源：{parseResult.source === "rule+llm" ? "规则 + 模型补全" : "纯规则"}
                    </Typography.Text>
                  ) : null}
                </Space>
                {parseResult ? (
                  <Space size={6} wrap>
                    {(parseResult.filled ?? []).filter((f) => f !== "notes").map((f) => (
                      <Tag key={f} color="blue">
                        识别到 {f}
                      </Tag>
                    ))}
                    {(parseResult.filledByModel ?? []).map((f) => (
                      <Tag key={`m-${f}`} color="purple">
                        模型补 {f}
                      </Tag>
                    ))}
                    {(parseResult.missing ?? []).map((f) => (
                      <Tag key={`x-${f}`} color="orange">
                        仍缺 {f}
                      </Tag>
                    ))}
                  </Space>
                ) : null}
                {parseResult?.clarifications?.length ? (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    追问：{parseResult.clarifications.join("；")}
                  </Typography.Text>
                ) : null}
                {parseResult?.llmNote ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {parseResult.llmNote}
                  </Typography.Text>
                ) : null}
              </Space>
            }
          />

          <Form<FormValues>
            form={form}
            layout="vertical"
            initialValues={{ ...DEFAULTS, window: defaultWindow() }}
            onFinish={(v) => void submit(v)}
            onValuesChange={(_changed, all) => syncWeights(all)}
            requiredMark="optional"
          >
            <Divider orientation="left" plain style={{ marginTop: 0 }}>
              基本信息
            </Divider>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="industry" label="行业" rules={[{ required: true, message: "请填写行业" }]}>
                  <Input placeholder="美妆" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="category" label="类目" rules={[{ required: true, message: "请填写类目" }]}>
                  <Input placeholder="护肤品-精华" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              name="brandIds"
              label="品牌 ID"
              rules={[{ required: true, message: "至少填一个品牌 ID" }]}
              extra="回车可添加多个；品牌 ID 用于锁定竞品集合"
            >
              <Select mode="tags" placeholder="输入后回车" open={false} suffixIcon={null} tokenSeparators={[","]} />
            </Form.Item>

            <Divider orientation="left" plain>
              投放设置
            </Divider>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="budgetWan" label="预算（万元）" rules={[{ required: true, message: "请填写预算" }]}>
                  <InputNumber min={1} step={10} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="platforms"
                  label="平台（可多选）"
                  rules={[{ required: true, message: "至少选择一个平台" }]}
                >
                  <Checkbox.Group
                    options={POPULAR_PLATFORMS.map((p) => ({ label: PLATFORM_LABEL[p], value: p }))}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Divider orientation="left" plain>
              目标权重
              <Typography.Text
                type={sumOk ? "secondary" : "danger"}
                style={{ fontSize: 12, marginLeft: 10, fontWeight: 400 }}
              >
                合计 {weightSum.toFixed(2)} {sumOk ? "" : "（需等于 1）"}
              </Typography.Text>
            </Divider>
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item name="awareness" label="认知" rules={[{ required: true, message: "必填" }]}>
                  <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="conversion" label="转化" rules={[{ required: true, message: "必填" }]}>
                  <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="retention" label="留存" rules={[{ required: true, message: "必填" }]}>
                  <InputNumber min={0} max={1} step={0.05} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
            </Row>

            <Divider orientation="left" plain>
              时间窗口
            </Divider>
            <Form.Item name="window" rules={[{ required: true, message: "请选择时间窗口" }]}>
              <DatePicker.RangePicker style={{ width: "100%" }} format="YYYY-MM-DD" />
            </Form.Item>

            <Form.Item name="notes" label="补充说明">
              <Input.TextArea rows={2} placeholder="竞品、素材方向、必须避开的表述等" />
            </Form.Item>

            <Button
              type="primary"
              htmlType="submit"
              icon={<RocketOutlined />}
              loading={submitting}
              disabled={!sumOk}
              block
              size="large"
            >
              提交并开始执行
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              提交后自动建立 SSE 连接，实时观察六个阶段。幂等键 {idemKey.slice(0, 8)}…（本次录入内复用）
            </Typography.Text>
          </Form>
        </Card>
      </Col>

      <Col xs={24} xl={9}>
        <Card title="提交后会发生什么" size="small">
          <Space direction="vertical" size={10} style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            <Typography.Text>
              <b>1 录入与授权核验</b> — 校验 Brief 完整性与数据源授权范围
            </Typography.Text>
            <Typography.Text>
              <b>2 竞品情报分析</b> — 按 Brief 声明的平台各预取一次公开内容聚合，再按需补充
            </Typography.Text>
            <Typography.Text>
              <b>3 达人/人选匹配</b> — 从知识库与已采集公开内容中筛候选
            </Typography.Text>
            <Typography.Text>
              <b>4 打法与排期</b> — 输出可执行的内容与投放节奏
            </Typography.Text>
            <Typography.Text>
              <b>5 预算与风控</b> — 按目标权重分配预算并做合规校验
            </Typography.Text>
            <Typography.Text>
              <b>6 研报生成与渲染</b> — 产出 HTML / Markdown / DSL 三份报告
            </Typography.Text>
          </Space>
        </Card>

        <Card title="两个容易踩的点" size="small" style={{ marginTop: 16 }}>
          <Space direction="vertical" size={10} style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            <Typography.Text type="secondary">
              跨平台指标只有<b>共有项</b>可比。七个平台在内容层没有统一指标时，
              报告会写"不可跨平台对比"，而不是把不同口径的数字摆在一起。
            </Typography.Text>
            <Typography.Text type="secondary">
              降级不是错误。授权过期、来源不可达会以<b>降级</b>形式出现在阶段卡片和事件流里，
              任务仍会跑完，并在报告的"排除项"里如实说明。
            </Typography.Text>
          </Space>
        </Card>
      </Col>
    </Row>
  );
}
