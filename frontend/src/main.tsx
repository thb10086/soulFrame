import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      algorithm: theme.darkAlgorithm,
      token: {
        colorPrimary: "#7aa2ff",
        borderRadius: 10,
        colorBgBase: "#0c0e1d",
        colorBgContainer: "#12152b",
        colorBgElevated: "#181c36",
        colorBorder: "#262c55",
        colorBorderSecondary: "#1f2447",
        fontSize: 14,
      },
      components: {
        Layout: { headerBg: "#0d101f", siderBg: "#0d101f", bodyBg: "#0c0e1d" },
        Menu: { itemBg: "transparent", itemSelectedBg: "rgba(122,162,255,.14)" },
        Card: { colorBgContainer: "#12152b" },
      },
    }}
  >
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </ConfigProvider>
);
