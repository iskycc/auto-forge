import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("packages the custom Next.js server with production workspace dependencies", async () => {
  const [dockerfile, nextConfiguration] = await Promise.all([
    readFile("deploy/docker/backend.Dockerfile", "utf8"),
    readFile("apps/web/next.config.ts", "utf8"),
  ]);

  assert.doesNotMatch(nextConfiguration, /output:\s*["']standalone["']/);
  assert.match(dockerfile, /\bCI=1\b/);

  const webBuild = dockerfile.indexOf("pnpm --filter @autoforge/web build");
  const workerBuild = dockerfile.indexOf("pnpm --filter @autoforge/worker build");
  const productionInstall = dockerfile.indexOf(
    "pnpm install --offline --frozen-lockfile --prod --ignore-scripts",
  );
  assert.ok(webBuild >= 0, "the Web production build must be present");
  assert.ok(workerBuild > webBuild, "the worker must be built after the Web application");
  assert.ok(
    productionInstall > workerBuild,
    "development dependencies must be pruned only after all production builds",
  );

  for (const requiredRuntimePath of [
    "/workspace/node_modules ./node_modules",
    "/workspace/packages ./packages",
    "/workspace/apps/web/node_modules ./apps/web/node_modules",
    "/workspace/apps/web/.next ./apps/web/.next",
    "/workspace/apps/web/dist-server ./apps/web/dist-server",
    "/workspace/apps/worker/node_modules ./apps/worker/node_modules",
    "/workspace/apps/worker/dist ./apps/worker/dist",
  ]) {
    assert.match(
      dockerfile,
      new RegExp(requiredRuntimePath.replaceAll("/", "\\/").replaceAll(".", "\\.")),
      `runtime image is missing ${requiredRuntimePath}`,
    );
  }
  assert.doesNotMatch(dockerfile, /\.next\/standalone/);
});

test("executes the migration entry point while verifying a release image", async () => {
  const verificationScript = await readFile("scripts/release/verify-backend-image.sh", "utf8");

  assert.match(verificationScript, /node \/app\/apps\/web\/dist-server\/server\/migrate\.js/);
  assert.doesNotMatch(
    verificationScript,
    /test -f \/app\/apps\/web\/dist-server\/server\/migrate\.js/,
  );
});
