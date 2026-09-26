/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // In npm run dev there is no nginx in front, so the socket path is proxied to market-data here
  // (VITE_MARKET_DATA_PORT, default 8001), as nginx does inside the container.
  server: {
    proxy: { "/ws": { target: `ws://localhost:${process.env.VITE_MARKET_DATA_PORT ?? "8001"}`, ws: true } },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
