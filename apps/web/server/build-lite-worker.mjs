import { build } from "esbuild";

await build({
  entryPoints: [new URL("./lite-work-thread.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["better-sqlite3"],
  outfile: new URL("../dist-server/server/lite-work-thread.js", import.meta.url).pathname,
  logLevel: "info",
});
