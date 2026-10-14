import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { App } from "./App.tsx";
import { themeConfig } from "./theme.ts";
import "./styles.css";

dayjs.locale("zh-cn");

/**
 * 刻意不套 `<StrictMode>`。
 *
 * StrictMode 在开发态会**故意**把 effect 跑两遍（mount → unmount → mount）。
 * 我们的首屏 effect 里建立的是 SSE 长连接和一次 `POST /brief/parse` 之类的真实请求，
 * 双跑会连着网关开两条流、多打一次模型调用（这两个动作都要花钱）。
 * 保证正确性的手段放在代码里（effect 的 cleanup 一定会 abort），
 * 而不是靠 StrictMode 在开发期替我们暴露——那笔账不该记在真实端点上。
 */
const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 挂载点");

createRoot(container).render(
  <ConfigProvider locale={zhCN} theme={themeConfig}>
    {/* antd 的 App 提供 message/notification/modal 的上下文版本，避免静态方法拿不到主题与 locale */}
    <AntApp>
      <App />
    </AntApp>
  </ConfigProvider>,
);
