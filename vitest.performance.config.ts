import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 导出工作簿生成位于 apps/web（Next.js 专用包）；性能测试绕过其 tsconfig 上下文直接引用，
      // server-only 标记包在测试环境不可用，指向空模块避免加载失败。
      "@/export-workbook": "/opt/auto-forge/apps/web/src/lib/run-batch-export-xlsx.ts",
      "server-only": "/opt/auto-forge/apps/web/node_modules/server-only/empty.js",
      exceljs: "/opt/auto-forge/apps/web/node_modules/exceljs/excel.js",
    },
  },
  test: {
    environment: "node",
    include: ["tests/performance/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
