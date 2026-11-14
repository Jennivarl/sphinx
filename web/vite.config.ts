import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Relative base so the same build works on any host path.
// NEAR wallet modules still expect Node's Buffer, process and global in the browser.
export default defineConfig({
  base: "./",
  plugins: [react(), nodePolyfills({ include: ["buffer", "process", "crypto", "stream", "util"], globals: { Buffer: true, process: true, global: true } })],
});
