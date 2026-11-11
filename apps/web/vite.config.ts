import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開発時は API と WebSocket をローカルのサーバー（既定 8790）へ中継する。
// サーバーは Host・Origin が自分（localhost:8790）でないリクエストを断るため、中継のときに付け替える
const target = `http://127.0.0.1:${process.env.KANSEI_PORT ?? 8790}`;
const relay = { target, changeOrigin: true, headers: { origin: target } };

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    proxy: {
      "/api": relay,
      "/ws": { ...relay, ws: true },
    },
  },
});
