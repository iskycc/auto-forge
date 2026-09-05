import { build } from "esbuild";

for (const entry of ["work-thread", "read-model-thread"])
  await build({
    entryPoints: [new URL(`./${entry}.ts`, import.meta.url).pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["better-sqlite3"],
    // pg/minio 等依赖内部存在对 Node 内置模块的动态 require；ESM 产物需要
    // 显式提供 require，否则工作线程在首次加载驱动时抛出 "Dynamic require"。
    banner: {
      js: "import { createRequire as __autoforgeWorkThreadCreateRequire } from 'node:module'; const require = __autoforgeWorkThreadCreateRequire(import.meta.url);",
    },
    outfile: new URL(`../dist-server/server/${entry}.js`, import.meta.url).pathname,
    logLevel: "info",
  });
