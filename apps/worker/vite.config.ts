import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    ssr: true,
    target: "node24",
    rolldownOptions: {
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
