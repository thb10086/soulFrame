/** 布局：顶部导航 + 左侧菜单 + 主内容区（产品原型 §3.2 推荐布局，深色高级感主题） */
import {
  DatabaseOutlined,
  HomeOutlined,
  PlusCircleOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Avatar, Layout, Menu, Space, Typography } from "antd";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import GradientText from "./components/bits/GradientText";
import AnimReviewPage from "./pages/AnimReview";
import ChatPage from "./pages/Chat";
import CharactersPage from "./pages/Characters";
import CreateWizardPage from "./pages/CreateWizard";
import DashboardPage from "./pages/Dashboard";
import MemoriesPage from "./pages/Memories";
import SettingsPage from "./pages/Settings";

const { Header, Sider, Content } = Layout;

const MENU = [
  { key: "/", icon: <HomeOutlined />, label: "首页" },
  { key: "/characters", icon: <TeamOutlined />, label: "我的角色" },
  { key: "/create", icon: <PlusCircleOutlined />, label: "创建角色" },
  { key: "/memories", icon: <DatabaseOutlined />, label: "记忆管理" },
  { key: "/settings", icon: <SettingOutlined />, label: "个人设置" },
];

export default function App() {
  const nav = useNavigate();
  const loc = useLocation();
  const selected = MENU.map((m) => m.key)
    .filter((k) => (k === "/" ? loc.pathname === "/" : loc.pathname.startsWith(k)))
    .slice(-1);
  const isChat = loc.pathname.startsWith("/chat") || loc.pathname.startsWith("/dev/");

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingInline: 24,
          borderBottom: "1px solid #1d2244",
          position: "relative",
          zIndex: 10,
        }}
      >
        <Space size={12} style={{ cursor: "pointer" }} onClick={() => nav("/")}>
          <span style={{ fontSize: 22, lineHeight: 1 }}>✦</span>
          <GradientText
            colors={["#7aa2ff", "#c08cff", "#ff9ac4", "#7aa2ff"]}
            animationSpeed={6}
            showBorder={false}
            className="sf-logo"
          >
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: 0.5 }}>
              SoulFrame · AI 虚拟偶像平台
            </span>
          </GradientText>
        </Space>
        <Space>
          <Typography.Text style={{ color: "#9aa4d2" }}>开发者</Typography.Text>
          <Avatar style={{ background: "linear-gradient(135deg,#5b7cfa,#a86bff)" }}>开</Avatar>
        </Space>
      </Header>
      <Layout>
        {!isChat && (
          <Sider width={200} style={{ borderRight: "1px solid #1d2244" }}>
            <Menu
              mode="inline"
              items={MENU}
              selectedKeys={selected}
              onClick={(e) => nav(e.key)}
              style={{ borderInlineEnd: "none", paddingTop: 8, background: "transparent" }}
            />
          </Sider>
        )}
        <Content style={{ background: "#0c0e1d" }}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/characters" element={<CharactersPage />} />
            <Route path="/create" element={<CreateWizardPage />} />
            <Route path="/create/:id" element={<CreateWizardPage />} />
            <Route path="/chat/:id" element={<ChatPage />} />
            <Route path="/memories" element={<MemoriesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/dev/anim-review" element={<AnimReviewPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
