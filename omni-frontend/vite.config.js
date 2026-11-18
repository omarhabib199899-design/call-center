import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served from /new/ on the dev site (dev.hunaix.online/new/) next to the old panel.
  base: "/new/",
  plugins: [react()],
  server: {
    // Point API calls at the existing WhatsCRM backend during development.
    proxy: {
      "/api": { target: "https://dev.hunaix.online", changeOrigin: true, secure: true },
      "/socket.io": { target: "https://dev.hunaix.online", ws: true, changeOrigin: true, secure: true },
    },
  },
});
