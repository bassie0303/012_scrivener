import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// 行政書士アプリ（私的使用）。問題JSONは public/data/ に手動配置（gitignore済み）し
// Service Worker でオフラインキャッシュする。問題本文はサーバー配信しない。
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      // public/data/*.json（手動配置の問題データ）もインストール後オフラインで使えるようキャッシュ
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,json}"],
        // 問題JSONは初回アクセス時にキャッシュ（同梱しないので runtime caching）
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/data/"),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "gyosei-questions" },
          },
        ],
      },
      manifest: {
        name: "行政書士 過去問",
        short_name: "過去問",
        description: "自分専用の行政書士試験 過去問学習アプリ",
        lang: "ja",
        theme_color: "#1c2c4c",
        background_color: "#e9ecf1",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
    }),
  ],
});
