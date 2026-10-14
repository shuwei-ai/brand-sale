import { HashRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { Button, Result } from "antd";
import { AppShell } from "./components/AppShell.tsx";
import { NewJobPage } from "./pages/NewJobPage.tsx";
import { JobListPage } from "./pages/JobListPage.tsx";
import { JobDetailPage } from "./pages/JobDetailPage.tsx";
import { KnowledgePage } from "./pages/KnowledgePage.tsx";
import { GovernancePage } from "./pages/GovernancePage.tsx";

function NotFound() {
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="控制台只有四个入口：新建任务、任务列表、知识库、数据源与审计。"
      extra={
        <Button type="primary" onClick={() => navigate("/jobs/new")}>
          回到新建任务
        </Button>
      }
    />
  );
}

/**
 * 路由用 HashRouter 而不是 BrowserRouter。
 *
 * 因为生产环境前端是**由网关托管在同一端口上**的：`/` 吐 index.html，
 * `/assets/*` 吐静态资源。用 History 路由就得让网关对所有未知路径兜底回 index.html，
 * 那样会把真正的 404（比如打错的 API 路径）也吞掉，排障时很难受。
 * hash 路由只占用 `#`，服务端永远只需要处理两个前缀。
 */
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/jobs/new" replace />} />
          <Route path="/jobs/new" element={<NewJobPage />} />
          <Route path="/jobs" element={<JobListPage />} />
          <Route path="/jobs/:jobId" element={<JobDetailPage />} />
          <Route path="/kb" element={<KnowledgePage />} />
          <Route path="/governance" element={<GovernancePage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
