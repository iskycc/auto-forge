import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  globalIgnores([
    "**/.local/**",
    "apps/log-archive-viewer/cmd/viewer/assets/viewer.js",
    "**/.next/**",
    "**/coverage/**",
    "**/dist/**",
    "**/dist-server/**",
    "**/node_modules/**",
    "**/target/**",
    "data/**",
    "fast-deploy/generated/**",
    "jenkins-test/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
