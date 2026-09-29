import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: ".harness",
  publicDir: "../public",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 19183, strictPort: true },
});
