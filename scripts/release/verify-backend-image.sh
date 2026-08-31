#!/usr/bin/env bash

set -Eeuo pipefail

readonly image_reference="${1:?usage: verify-backend-image.sh IMAGE PLATFORM}"
readonly platform="${2:?usage: verify-backend-image.sh IMAGE PLATFORM}"
container_id=""

cleanup() {
  if [[ -n "${container_id}" ]]; then
    docker rm --force "${container_id}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

container_id="$(docker run --detach --network none --platform "${platform}" "${image_reference}")"

for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${container_id}")"
  case "${status}" in
    healthy)
      docker exec "${container_id}" node /app/apps/web/dist-server/server/migrate.js \
        --data-dir=/tmp/autoforge-migration-check
      docker exec --workdir /app/apps/web "${container_id}" node --input-type=module -e '
        const nats = await import("nats");
        if (typeof nats.connect !== "function" || typeof nats.JSONCodec !== "function") {
          throw new Error("NATS runtime exports are incomplete");
        }
      '
      docker exec "${container_id}" node -e '
        const { createHash } = require("node:crypto");
        const { existsSync, readFileSync, readdirSync } = require("node:fs");
        const { relative, resolve, sep } = require("node:path");
        if (existsSync("/app/apps/web/.next/cache")) throw new Error("runtime image contains Next.js build cache");
        const packageStore = "/app/node_modules/.pnpm";
        const developmentPackages = /^(?:@playwright\+test|eslint|playwright|prettier|typescript|vitest)@/;
        const unexpectedPackage = readdirSync(packageStore).find((entry) => developmentPackages.test(entry));
        if (unexpectedPackage) throw new Error(`runtime image contains development dependency: ${unexpectedPackage}`);
        const nextServerRoot = "/app/apps/web/.next/server";
        const appPaths = JSON.parse(readFileSync(`${nextServerRoot}/app-paths-manifest.json`, "utf8"));
        const routeEntries = Object.entries(appPaths);
        if (routeEntries.length === 0) throw new Error("runtime image has no Next.js app routes");
        const missingRoutes = [];
        for (const [route, modulePath] of routeEntries) {
          if (typeof modulePath !== "string") throw new Error(`invalid module path for ${route}`);
          const moduleFile = resolve(nextServerRoot, modulePath);
          const relativeModule = relative(nextServerRoot, moduleFile);
          if (relativeModule === ".." || relativeModule.startsWith(`..${sep}`)) {
            throw new Error(`Next.js route escapes server root: ${route}`);
          }
          if (!existsSync(moduleFile)) missingRoutes.push(`${route} -> ${modulePath}`);
        }
        if (missingRoutes.length > 0) throw new Error(`runtime image is missing Next.js routes: ${missingRoutes.join(", ")}`);
        process.stdout.write(`Verified ${routeEntries.length} Next.js app route modules.\n`);
        const root = "/app/resources/agents";
        const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
        for (const key of ["linux-amd64", "linux-arm64", "installer", "adapter"]) {
          const entry = manifest.files[key];
          const content = readFileSync(`${root}/${entry.path}`);
          if (content.length !== entry.size || createHash("sha256").update(content).digest("hex") !== entry.sha256) process.exit(1);
        }
      '
      case "${platform}" in
        linux/amd64) agent_architecture="amd64" ;;
        linux/arm64) agent_architecture="arm64" ;;
        *) echo "unsupported backend platform: ${platform}" >&2; exit 1 ;;
      esac
      docker exec "${container_id}" \
        "/app/resources/agents/linux-${agent_architecture}/autoforge-agent" version >/dev/null
      exit 0
      ;;
    unhealthy | missing)
      docker logs "${container_id}" >&2
      echo "backend container health status: ${status}" >&2
      exit 1
      ;;
  esac
  sleep 1
done

docker logs "${container_id}" >&2
echo "backend container did not become healthy within 60 seconds" >&2
exit 1
