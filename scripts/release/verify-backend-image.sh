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
        if (existsSync("/app/apps/web/.next/cache")) throw new Error("runtime image contains Next.js build cache");
        const packageStore = "/app/node_modules/.pnpm";
        const developmentPackages = /^(?:@playwright\+test|eslint|playwright|prettier|typescript|vitest)@/;
        const unexpectedPackage = readdirSync(packageStore).find((entry) => developmentPackages.test(entry));
        if (unexpectedPackage) throw new Error(`runtime image contains development dependency: ${unexpectedPackage}`);
        for (const route of [
          "/app/apps/web/.next/server/app/api/v1/ldap/test/route.js",
          "/app/apps/web/.next/server/app/api/v1/webhooks/[webhookId]/test/route.js",
        ]) {
          if (!existsSync(route)) throw new Error(`runtime image is missing API route: ${route}`);
        }
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
