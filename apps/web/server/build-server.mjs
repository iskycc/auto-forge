import { build } from "esbuild";
import { rm } from "node:fs/promises";

const serverDirectory = new URL(".", import.meta.url);
const outputDirectory = new URL("../dist-server/server", serverDirectory);

// This directory only contains generated server artifacts. Removing it avoids
// retaining stale chunks after entry-point or dependency changes.
await rm(outputDirectory, { recursive: true, force: true });

await build({
  entryPoints: {
    index: new URL("./index.ts", serverDirectory).pathname,
    migrate: new URL("./migrate.ts", serverDirectory).pathname,
    "prepare-node": new URL("./prepare-node.ts", serverDirectory).pathname,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  splitting: true,
  // NATS and Redis expose CommonJS entry points whose named exports are discovered by
  // Node, but not when esbuild rewrites a dynamic import into a split ESM
  // chunk. Keep it external so Full mode receives Node's native interop.
  external: ["better-sqlite3", "nats", "redis", "next"],
  // Several bundled database and transport dependencies use dynamic require for
  // optional Node integrations. Production ESM output must provide a scoped
  // require without exposing build-time module resolution.
  banner: {
    js: "import { createRequire as __autoforgeServerCreateRequire } from 'node:module'; const require = __autoforgeServerCreateRequire(import.meta.url);",
  },
  outdir: outputDirectory.pathname,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  sourcemap: false,
  logLevel: "info",
});
