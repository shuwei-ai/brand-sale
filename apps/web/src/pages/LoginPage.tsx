import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Spin, Typography } from "antd";
import { CheckCircleFilled, ReloadOutlined, WechatOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { api } from "../api/endpoints.ts";
import { login } from "../api/session.ts";
import { PALETTE } from "../theme.ts";

/**
 * 扫码登录页（DreamAuth 微信扫码）。
 *
 * 流程：进入页面 → 后端创建扫码会话（返回二维码 base64 + sessionNo）→
 * 每 2 秒轮询状态 → 检测到「已授权」→ 调 complete 取结果 → 写入 token → 跳控制台。
 *
 * 状态机（对齐 DreamAuth）：1 待扫 / 2 已扫待确认 / 3 已授权 / 4 取消 / 6 已消费 / 7 过期。
 * 二维码过期或取消时提供「重新生成」，不强制用户刷新页面。
 */

type Phase = "loading" | "waiting" | "scanned" | "authorized" | "expired" | "cancelled" | "error";

const PHASE_COPY: Record<Phase, { title: string; hint: string }> = {
  loading: { title: "正在生成二维码", hint: "正在连接 DreamAuth 开放平台…" },
  waiting: { title: "微信扫码登录", hint: "打开微信「扫一扫」，扫描二维码后在小程序内确认授权" },
  scanned: { title: "已扫码，请确认", hint: "请在微信「DreamAuth」小程序里确认授权" },
  authorized: { title: "授权成功，正在登录", hint: "正在换取登录凭证…" },
  expired: { title: "二维码已过期", hint: "二维码有时效，重新生成一个即可" },
  cancelled: { title: "已取消授权", hint: "如需登录，请重新扫码" },
  error: { title: "登录服务不可用", hint: "扫码登录未启用或服务暂不可用，请联系管理员" },
};

export function LoginPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [qrcode, setQrcode] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const sessionNoRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const beginSession = useCallback(async () => {
    stopPolling();
    setPhase("loading");
    setErrorMsg("");
    setQrcode("");
    try {
      const created = await api.authCreateSession();
      sessionNoRef.current = created.sessionNo;
      setQrcode(created.qrcode);
      setPhase("waiting");
      startPolling(created.sessionNo);
    } catch (e) {
      setPhase("error");
      setErrorMsg(e instanceof Error ? (e as { userMessage?: string }).userMessage ?? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = useCallback((sessionNo: string) => {
    stopPolling();
    timerRef.current = setInterval(async () => {
      try {
        const s = await api.authSessionStatus(sessionNo);
        if (s.status === 3) {
          stopPolling();
          setPhase("authorized");
          const done = await api.authComplete(sessionNo);
          login(done.token, done.user);
          navigate("/jobs", { replace: true });
          return;
        }
        if (s.status === 2) {
          setPhase("scanned");
        } else if (s.status === 4) {
          stopPolling();
          setPhase("cancelled");
        } else if (s.status === 7) {
          stopPolling();
          setPhase("expired");
        } else if (s.status === 6) {
          // 已被消费但本地未完成 → 视为过期，引导重扫
          stopPolling();
          setPhase("expired");
        }
      } catch {
        // 轮询偶发失败不打断，等下一拍；连续失败由用户手动重试
      }
    }, 2000);
  }, [stopPolling, navigate]);

  useEffect(() => {
    beginSession();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = PHASE_COPY[phase];
  const terminal = phase === "expired" || phase === "cancelled" || phase === "error";

  return (
    <div className="login" style={{ ["--login-primary" as string]: PALETTE.primary }}>
      <div className="login-card">
        <header className="login-head">
          <span className="login-mark" aria-hidden>
            B
          </span>
          <div>
            <Typography.Text strong className="login-brand">
              brandsale
            </Typography.Text>
            <Typography.Text type="secondary" className="login-sub">
              品牌营销 AI 策略咨询
            </Typography.Text>
          </div>
        </header>

        <div className="login-body">
          <div className="login-qr-wrap">
            {phase === "loading" ? (
              <div className="login-qr login-qr--placeholder">
                <Spin size="large" />
              </div>
            ) : qrcode ? (
              <img className="login-qr" src={qrcode} alt="微信扫码登录二维码" />
            ) : (
              <div className="login-qr login-qr--placeholder">
                <WechatOutlined style={{ fontSize: 40, color: "#c7cde0" }} />
              </div>
            )}
            {phase === "scanned" && (
              <div className="login-qr-mask">
                <CheckCircleFilled style={{ fontSize: 42, color: PALETTE.ok }} />
                <span>已扫码</span>
              </div>
            )}
            {phase === "authorized" && (
              <div className="login-qr-mask">
                <Spin size="large" />
              </div>
            )}
          </div>

          <h1 className="login-title">{copy.title}</h1>
          <p className="login-hint">{copy.hint}</p>

          {terminal && (
            <div className="login-actions">
              {phase !== "error" ? (
                <Button type="primary" icon={<ReloadOutlined />} onClick={beginSession}>
                  重新生成二维码
                </Button>
              ) : (
                <Button type="primary" icon={<ReloadOutlined />} onClick={beginSession}>
                  重试
                </Button>
              )}
              <Button onClick={() => navigate("/")}>返回首页</Button>
            </div>
          )}

          {errorMsg && (
            <Alert
              style={{ marginTop: 16, textAlign: "left" }}
              type="error"
              showIcon
              message="登录失败"
              description={errorMsg}
            />
          )}
        </div>

        <footer className="login-foot">
          <WechatOutlined style={{ color: PALETTE.ok }} />
          <span>通过微信「DreamAuth」小程序完成授权，登录仅记录你的微信身份标识</span>
        </footer>
      </div>
    </div>
  );
}
