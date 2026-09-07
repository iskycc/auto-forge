import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    ssr: true,
    target: "node24",
    rolldownOptions: {
      input: {
        worker: "src/index.ts",
        "work-thread": "../web/server/work-thread.ts",
        "read-model-thread": "../web/server/read-model-thread.ts",
      },
      external: ["better-sqlite3"],
      output: {
        entryFileNames: (entry) => (entry.name === "worker" ? "worker.mjs" : "[name].js"),
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
