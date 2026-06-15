import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 后端固定 8787（本机 8000/8080 已被其他服务占用）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true, ws: true },
      "/healthz": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/files": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
