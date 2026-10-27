import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  main: { build: { externalizeDeps: true } },
  preload: { build: { externalizeDeps: true } },
  renderer: {
    plugins: [
      react(),
      {
        name: "development-csp",
        transformIndexHtml: (html) =>
          command === "serve"
            ? html.replace(
                "script-src 'self'",
                "script-src 'self' 'unsafe-inline'",
              )
            : html,
      },
    ],
    build: { minify: true },
  },
}));
