import { fileURLToPath } from "node:url";
import { build } from "vite";

const entries = [
  ["worker", "src/index.ts"],
  ["work-thread", "../web/server/work-thread.ts"],
  ["read-model-thread", "../web/server/read-model-thread.ts"],
];

// Each entry owns a process/thread lifecycle. A multi-entry build can place shared
// adapters inside another entry, making an adapter import start the wrong thread.
for (const [index, [name, entry]] of entries.entries()) {
  await build({
    root: import.meta.dirname,
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    build: {
      emptyOutDir: index === 0,
      rolldownOptions: { input: { [name]: entry } },
    },
  });
}
