import { Layout, Menu, Space, Typography } from "antd";
import {
  ApartmentOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  PlusSquareOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { HealthBadge } from "./HealthBadge.tsx";
import { TokenBox } from "./TokenBox.tsx";

const { Header, Sider, Content } = Layout;

const MENU = [
  { key: "/jobs/new", icon: <PlusSquareOutlined />, label: "新建任务" },
  { key: "/jobs", icon: <UnorderedListOutlined />, label: "任务列表" },
  { key: "/kb", icon: <DatabaseOutlined />, label: "知识库" },
  { key: "/governance", icon: <ApartmentOutlined />, label: "数据源与审计" },
];

/** 侧栏高亮键：/jobs/xxx 详情页也要把「任务列表」点亮 */
function selectedKey(pathname: string): string {
  if (pathname.startsWith("/jobs/new")) return "/jobs/new";
  if (pathname.startsWith("/jobs")) return "/jobs";
  if (pathname.startsWith("/kb")) return "/kb";
  if (pathname.startsWith("/governance")) return "/governance";
  return "/jobs/new";
}

export function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header className="bm-header" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="bm-logo" aria-hidden>
          B
        </div>
        <Space direction="vertical" size={0} style={{ lineHeight: 1.3 }}>
          <Typography.Text strong style={{ fontSize: 14.5 }}>
            brandsale 控制台
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            品牌营销 AI 策略咨询 · 六阶段流水线
          </Typography.Text>
        </Space>
        <div style={{ flex: 1 }} />
        <HealthBadge />
        <TokenBox />
      </Header>

      <Layout>
        <Sider className="bm-sider" width={196} breakpoint="lg" collapsedWidth={0} theme="light">
          <Menu
            mode="inline"
            theme="light"
            style={{ borderInlineEnd: "none", paddingTop: 12 }}
            selectedKeys={[selectedKey(pathname)]}
            items={MENU}
            onClick={({ key }) => navigate(key)}
          />
          <div style={{ padding: "16px 16px 24px", color: "#8a92a6", fontSize: 11, lineHeight: 1.7 }}>
            <FileTextOutlined /> 报告产物在任务详情的「产物」页签可预览与下载。
          </div>
        </Sider>

        <Content style={{ padding: "18px 20px 40px", minWidth: 0 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
