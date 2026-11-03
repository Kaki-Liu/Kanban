import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  base: "./",
  server: { port: 1420, strictPort: true },
  build: { outDir: "../../out/web", emptyOutDir: true, minify: true },
});
