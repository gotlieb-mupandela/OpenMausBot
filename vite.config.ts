import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react-dom") || id.includes("/react/")) return "react";
          if (id.includes("posthog")) return "posthog";
          if (id.includes("shiki") || id.includes("@shikijs")) return "shiki";
          if (id.includes("lucide-react")) return "icons";
          if (
            id.includes("react-markdown") ||
            id.includes("remark") ||
            id.includes("micromark") ||
            id.includes("/mdast") ||
            id.includes("/hast") ||
            id.includes("unified") ||
            id.includes("/unist")
          ) {
            return "markdown";
          }
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts"],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Keep PostCSS local. Without this, Vite walks up and loads
  // ~/postcss.config.js (Tailwind v3), which breaks @import "tailwindcss".
  css: {
    postcss: {
      plugins: [],
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      // SSE must not be buffered; longer timeouts keep EventSource alive.
      "/api/events": {
        target: `http://127.0.0.1:${process.env.OGB_PORT || 8799}`,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["cache-control"] = "no-cache, no-transform";
            proxyRes.headers["x-accel-buffering"] = "no";
            // Prevent http-proxy from buffering the whole stream.
            delete proxyRes.headers["content-length"];
          });
        },
      },
      "/api": {
        target: `http://127.0.0.1:${process.env.OGB_PORT || 8799}`,
        changeOrigin: true,
      },
    },
  },
});
