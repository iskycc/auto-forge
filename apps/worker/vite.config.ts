import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    ssr: "src/index.ts",
    target: "node24",
    rollupOptions: {
      output: {
        entryFileNames: "worker.mjs",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
