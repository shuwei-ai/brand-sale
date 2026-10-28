/**
 * 平台绑定页 —— 服务端无头扫码（方案 A）。
 *
 * 页面只做三件用户能理解的事：看到每个平台**现在**是什么状态、扫码把某个平台绑上、
 * 以及必要时重新检测。登录动作在服务端跑（无头 chromium + 二维码回传），
 * 浏览器不需要装任何插件，也不需要运维开 VNC。
 *
 * 状态为什么有四种而不是两种：`bound` 是**探活通过**（接口/页面确认），`unverified`
 * 只是「cookie 还在但无法确认」。把后者显示成「已绑定」会让用户以为可以采集，
 * 结果一跑就是 0 条数据 —— 这个项目里最不能犯的错就是"看起来有数据"。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  Modal,
  Progress,
  Row,
  Skeleton,
  Space,
  Tag,
  Typography,
} from "antd";
import { CheckCircleOutlined, KeyOutlined, QrcodeOutlined, ReloadOutlined, ScanOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { ApiError } from "../api/client.ts";
import { api } from "../api/endpoints.ts";
import type {
  PlatformBinding,
  PlatformBindingState,
  PlatformLoginSession,
  PlatformsResponse,
} from "../api/types.ts";

const STATE_META: Record<PlatformBindingState, { label: string; color: string; hint: string }> = {
  bound: { label: "已绑定", color: "green", hint: "探活确认登录态有效" },
  unbound: { label: "未绑定", color: "default", hint: "探活确认未登录" },
  unverified: { label: "待验证", color: "gold", hint: "有登录 cookie，但无法确认是否仍有效" },
  error: { label: "探测失败", color: "red", hint: "浏览器或网络异常，本次没能判断" },
  unavailable: { label: "未接入", color: "default", hint: "采集 sidecar 未接入" },
};

const TERMINAL = new Set(["succeeded", "failed", "timeout", "cancelled"]);

const isTerminal = (s: PlatformLoginSession | null): boolean => Boolean(s && TERMINAL.has(s.state));

const errText = (e: unknown): string => (e instanceof ApiError ? e.display : e instanceof Error ? e.message : String(e));

export function PlatformsPage() {
  const { message } = App.useApp();
  const [data, setData] = useState<PlatformsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [session, setSession] = useState<PlatformLoginSession | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /* 手动填 cookie 弹层 */
  const [cookieTarget, setCookieTarget] = useState<PlatformBinding | null>(null);
  const [cookieText, setCookieText] = useState("");
  const [submittingCookie, setSubmittingCookie] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const r = await api.platforms(signal);
        setData(r);
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return;
        message.error(errText(e));
      } finally {
        setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const active = Boolean(session && !isTerminal(session));

  /* 轮询会话：2s 一次。二维码变化、扫码成功、超时都在这一次请求里带回来 */
  useEffect(() => {
    if (!active || !session) return;
    const id = session.id;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const r = await api.pollPlatformLogin(id);
          setSession(r.session);
          if (r.session.state === "succeeded") {
            message.success(`${r.session.name}：${r.session.message ?? "登录成功"}`);
            void load();
          }
        } catch (e) {
          // 会话过期/被清理：停止轮询，让用户重新发起，别把错误刷屏
          setSession((cur) => (cur && cur.id === id ? { ...cur, state: "failed", message: errText(e) } : cur));
        }
      })();
    }, 2000);
    return () => clearInterval(timer);
  }, [active, session?.id, load, message]);

  /* 二维码倒计时：只在 waiting_scan 时滴答，避免整页每秒重渲染 */
  useEffect(() => {
    if (session?.state !== "waiting_scan") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session?.state, session?.qrAt]);

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.checkPlatforms();
      setData((cur) => (cur ? { ...cur, ...r } : r));
      message.success(`已检测 ${r.platforms?.length ?? 0} 个平台`);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setChecking(false);
    }
  };

  const startLogin = async (platform: string) => {
    setStarting(platform);
    try {
      const r = await api.startPlatformLogin(platform);
      setSession(r.session);
      setNow(Date.now());
    } catch (e) {
      message.error(errText(e));
    } finally {
      setStarting(null);
    }
  };

  const closeSession = async () => {
    const cur = session;
    setSession(null);
    if (cur && !isTerminal(cur)) await api.cancelPlatformLogin(cur.id).catch(() => undefined);
  };

  const submitCookie = async () => {
    if (!cookieTarget) return;
    const text = cookieText.trim();
    if (!text) {
      message.warning("请先粘贴 cookie");
      return;
    }
    setSubmittingCookie(true);
    try {
      const r = await api.setPlatformCookie(cookieTarget.platform, text);
      const meta = STATE_META[r.status.state] ?? STATE_META.error;
      if (r.status.state === "bound") {
        message.success(`${cookieTarget.name}：cookie 有效，已绑定`);
      } else if (r.status.state === "unverified") {
        message.warning(`${cookieTarget.name}：${r.status.detail ?? "cookie 已写入，但无法确认是否有效"}`);
      } else {
        message.error(`${cookieTarget.name}：${r.status.detail ?? meta.hint}`);
      }
      setCookieTarget(null);
      setCookieText("");
      void load();
    } catch (e) {
      message.error(errText(e));
    } finally {
      setSubmittingCookie(false);
    }
  };

  const counts = useMemo(() => {
    const list = data?.platforms ?? [];
    return {
      bound: list.filter((p) => p.state === "bound").length,
      total: list.length,
    };
  }, [data]);

  const qrLeft = useMemo(() => {
    if (!session?.qrExpiresAt) return null;
    return Math.max(0, Math.round((dayjs(session.qrExpiresAt).valueOf() - now) / 1000));
  }, [session?.qrExpiresAt, now]);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={
          <Space>
            <ScanOutlined />
            <span>平台绑定</span>
            {data?.platforms?.length ? (
              <Tag color={counts.bound > 0 ? "green" : "default"}>
                已绑定 {counts.bound}/{counts.total}
              </Tag>
            ) : null}
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading && !data}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={checking || Boolean(data?.probing)}
              disabled={data ? !data.configured : false}
              onClick={() => void check()}
            >
              检测登录状态
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message="扫码在服务器上完成：点「扫码绑定」后，二维码会显示在这里，用手机 App 扫即可。"
          description={
            <span style={{ fontSize: 12.5 }}>
              登录态写入服务器上与采集共用的浏览器 profile（每个平台一份），
              之后所有采集任务直接复用它；二维码约 2 分钟过期，过期后重新发起即可。
              建议只绑定已获采集授权的账号 —— 平台侧对「新设备 + 异地 IP」通常会要求二次验证。
            </span>
          }
        />

        {data && !data.configured ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 14 }}
            message="采集 sidecar 未接入，无法查询或绑定平台"
            description={
              <span style={{ fontSize: 12.5 }}>
                {data.reason ?? "未配置 BM_MC_COLLECTOR_URL"}。启动 `npm run collector` 并在 `.env` 里设置
                `BM_MC_COLLECTOR_URL=http://127.0.0.1:8890` 后刷新本页。
              </span>
            }
          />
        ) : null}

        {data?.configured && data.mcEnabled === false ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 14 }}
            message="采集开关未打开（BM_MC_ENABLED=false）"
            description="绑定会正常写入登录态，但采集适配器与工具都不会装配 —— 报告里仍然没有平台数据。"
          />
        ) : null}

        {loading && !data ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <Row gutter={[12, 12]}>
            {(data?.platforms ?? []).map((p) => (
              <Col key={p.platform} xs={24} sm={12} lg={8} xxl={6}>
                <PlatformCard
                  item={p}
                  starting={starting === p.platform}
                  disabled={!data?.configured}
                  onLogin={() => void startLogin(p.platform)}
                  onCookie={() => {
                    setCookieTarget(p);
                    setCookieText("");
                  }}
                />
              </Col>
            ))}
          </Row>
        )}

        <Typography.Paragraph type="secondary" style={{ marginTop: 14, marginBottom: 0, fontSize: 12 }}>
          最后检测：
          {data?.checkedAt ? dayjs(data.checkedAt).format("YYYY-MM-DD HH:mm:ss") : "尚未检测"}
          {" · "}
          同一时刻只允许一个浏览器会话（扫码或检测），这是内核串行采集的硬约束。
        </Typography.Paragraph>
      </Card>

      <Modal
        open={Boolean(session)}
        title={session ? `${session.name} · 扫码登录` : ""}
        onCancel={() => void closeSession()}
        footer={
          <Space>
            <Button onClick={() => void closeSession()}>关闭</Button>
            {session && isTerminal(session) ? (
              <Button
                type="primary"
                onClick={() => {
                  const p = session.platform;
                  setSession(null);
                  void startLogin(p);
                }}
              >
                重新扫码
              </Button>
            ) : (
              <Button
                danger
                onClick={() => {
                  if (session) void api.cancelPlatformLogin(session.id).catch(() => undefined);
                  setSession(null);
                }}
              >
                取消登录
              </Button>
            )}
          </Space>
        }
        width={460}
        destroyOnClose
      >
        {session ? (
          <Space direction="vertical" size={12} style={{ width: "100%", alignItems: "center" }}>
            {session.qrDataUrl && session.state === "waiting_scan" ? (
              <>
                <img
                  src={session.qrDataUrl}
                  alt={`${session.name} 登录二维码`}
                  style={{ width: 220, height: 220, border: "1px solid #eee", borderRadius: 8, background: "#fff" }}
                />
                <Progress
                  percent={qrLeft !== null ? Math.round((qrLeft / 120) * 100) : 0}
                  status={qrLeft && qrLeft > 0 ? "active" : "exception"}
                  showInfo={false}
                  style={{ width: 220 }}
                  size="small"
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {qrLeft && qrLeft > 0 ? `二维码剩余约 ${qrLeft}s（过期会自动刷新）` : "二维码可能已过期，可点「重新扫码」"}
                </Typography.Text>
              </>
            ) : null}

            {session.state === "starting" ? (
              <Space direction="vertical" align="center" style={{ padding: "28px 0" }}>
                <QrcodeOutlined style={{ fontSize: 42, color: "#bbb" }} />
                <Typography.Text type="secondary">正在启动无头浏览器并获取二维码…</Typography.Text>
              </Space>
            ) : null}

            {session.state === "succeeded" ? (
              <Space direction="vertical" align="center" style={{ padding: "18px 0" }}>
                <CheckCircleOutlined style={{ fontSize: 44, color: "#52c41a" }} />
                <Typography.Text strong>{session.message ?? "登录成功"}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  采集子进程下次启动会直接复用这份登录态。
                </Typography.Text>
              </Space>
            ) : null}

            {session.state === "failed" || session.state === "timeout" || session.state === "cancelled" ? (
              <Alert
                type={session.state === "cancelled" ? "info" : "error"}
                showIcon
                style={{ width: "100%" }}
                message={
                  session.state === "timeout"
                    ? "等待扫码超时"
                    : session.state === "cancelled"
                      ? "已取消"
                      : "登录失败"
                }
                description={session.message ?? "请重试；若反复失败，查看 collector 日志中的 login-*.log"}
              />
            ) : null}

            <Descriptions size="small" column={1} style={{ width: "100%" }} colon={false}>
              <Descriptions.Item label="会话状态">{session.state}</Descriptions.Item>
              <Descriptions.Item label="发起时间">{dayjs(session.startedAt).format("HH:mm:ss")}</Descriptions.Item>
              <Descriptions.Item label="会话截止">{dayjs(session.expiresAt).format("HH:mm:ss")}</Descriptions.Item>
            </Descriptions>
          </Space>
        ) : (
          <Empty />
        )}
      </Modal>

      <Modal
        open={Boolean(cookieTarget)}
        title={cookieTarget ? `${cookieTarget.name} · 手动填 cookie` : ""}
        onCancel={() => {
          if (!submittingCookie) {
            setCookieTarget(null);
            setCookieText("");
          }
        }}
        footer={
          <Space>
            <Button
              disabled={submittingCookie}
              onClick={() => {
                setCookieTarget(null);
                setCookieText("");
              }}
            >
              取消
            </Button>
            <Button type="primary" loading={submittingCookie} onClick={() => void submitCookie()}>
              写入并验证
            </Button>
          </Space>
        }
        width={560}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="什么时候用这个？"
            description={
              <span style={{ fontSize: 12.5 }}>
                扫码被平台风控（滑块 / 异地 IP）挡住时，先在本机浏览器登录该平台，
                再复制登录 cookie 粘贴到这里。写法：浏览器 DevTools → Network 里任意请求的
                `Cookie` 请求头，或 F12 → Application → Cookies 手动拼 `name=value; name2=value2`。
                写入后会立即探活，确认 sessionid 等登录标记是否真的有效。
              </span>
            }
          />
          <Input.TextArea
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
            placeholder={"例如：sessionid=abc123; LOGIN_STATUS=1; ..."}
            rows={6}
            autoSize={{ minRows: 4, maxRows: 10 }}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            cookie 属于敏感凭据，仅写入服务器上与采集共用的浏览器 profile，不会落日志或入库。
          </Typography.Text>
        </Space>
      </Modal>
    </Space>
  );
}

function PlatformCard({
  item,
  starting,
  disabled,
  onLogin,
  onCookie,
}: {
  item: PlatformBinding;
  starting: boolean;
  disabled: boolean;
  onLogin: () => void;
  onCookie: () => void;
}) {
  const meta = STATE_META[item.state] ?? STATE_META.error;
  return (
    <Card size="small" style={{ height: "100%" }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Typography.Text strong>{item.name}</Typography.Text>
          <Tag color={meta.color}>{meta.label}</Tag>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12, minHeight: 32, display: "block" }}>
          {item.detail || meta.hint}
        </Typography.Text>
        <Space size={6} wrap>
          <Button
            size="small"
            type={item.state === "bound" ? "default" : "primary"}
            icon={<QrcodeOutlined />}
            loading={starting}
            disabled={disabled}
            onClick={onLogin}
          >
            {item.state === "bound" ? "重新扫码" : "扫码绑定"}
          </Button>
          <Button size="small" icon={<KeyOutlined />} disabled={disabled} onClick={onCookie}>
            填 cookie
          </Button>
          {item.confidence ? (
            <Tag color={item.confidence === "verified" ? "blue" : "default"}>
              {item.confidence === "verified" ? "已探活" : "仅 cookie"}
            </Tag>
          ) : null}
        </Space>
      </Space>
    </Card>
  );
}
