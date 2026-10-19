import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and must not fall back to another one.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**", "**/report/**", "**/.tmp/**"] },
  },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
