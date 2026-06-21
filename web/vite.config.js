import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// 行政書士アプリ（私的使用）。
// 問題データは各端末ローカル（IndexedDB 取り込み）に持ち、サーバー/公開ビルドには含めない。
// 公開デプロイは GitHub Pages（プロジェクトページ＝サブパス /012_scrivener/）を想定。
export default defineConfig(({ command }) => {
  // 本番ビルド（GitHub Pages）はサブパス配信。dev はルート（localhost:5173/）。
  const base = command === "build" ? "/012_scrivener/" : "/";

  return {
    base,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["icon.svg"],
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,json}"],
        },
        manifest: {
          name: "行政書士 過去問",
          short_name: "過去問",
          description: "自分専用の行政書士試験 過去問学習アプリ",
          lang: "ja",
          theme_color: "#1c2c4c",
          background_color: "#e9ecf1",
          display: "standalone",
          id: base,
          start_url: base,
          scope: base,
          icons: [
            { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
          ],
        },
      }),
    ],
  };
});
