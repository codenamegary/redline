import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const apiServer = "http://127.0.0.1:4738"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: 4739,
    strictPort: true,
    proxy: {
      "/api": apiServer,
      "^/a/[^/]+/(current|v\\d+)(/|$)": apiServer,
    },
  },
})
