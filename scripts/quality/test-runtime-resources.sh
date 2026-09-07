#!/usr/bin/env bash
set -Eeuo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repository_root}"
readonly evidence_directory="${repository_root}/test-results/runtime-resources"
readonly runtime_directory="$(mktemp -d /tmp/autoforge-runtime-resources-XXXXXX)"
readonly protocol_directory="$(mktemp -d /tmp/autoforge-protocol-resources-XXXXXX)"
readonly image_name="autoforge/runtime-resources:check-$$"
readonly container_name="autoforge-runtime-resources-$$"
readonly node_image="$(sed -n 's/^ARG NODE_IMAGE=//p' deploy/docker/backend.Dockerfile)"
readonly multiple_cpus="${AUTOFORGE_RESOURCE_TEST_CPUS:-4}"
readonly acceptance_scope="${1:-execution}"
if [[ "${acceptance_scope}" != "execution" && "${acceptance_scope}" != "background" ]]; then
  echo "Expected execution or background acceptance scope." >&2
  exit 2
fi
rm -rf -- "${evidence_directory}"
mkdir -p "${evidence_directory}"

cleanup() {
  local status="$?"
  trap - EXIT
  set +e
  mkdir -p "${evidence_directory}"
  if docker container inspect "${container_name}" >/dev/null 2>&1; then
    docker logs "${container_name}" >"${evidence_directory}/web.log" 2>&1
    docker rm --force "${container_name}" >/dev/null
  fi
  docker image rm "${image_name}" >/dev/null 2>&1 || true
  rm -rf -- "${runtime_directory}" "${protocol_directory}"
  exit "${status}"
}
trap cleanup EXIT

# Explicitly offline: the immutable release base image and build dependencies must exist.
docker image inspect "${node_image}" >/dev/null
pnpm --filter @autoforge/web build >"${evidence_directory}/web-build.log" 2>&1
pnpm --filter @autoforge/worker build >"${evidence_directory}/worker-build.log" 2>&1
node scripts/release/package-backend-runtime.mjs "${runtime_directory}"
pnpm --filter @autoforge/web exec esbuild \
  "${repository_root}/tests/performance/runtime-resources-probe.ts" \
  --bundle --platform=node --format=esm --target=node24 --external:better-sqlite3 \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="${runtime_directory}/apps/web/dist-server/server/runtime-resources-probe.mjs"
docker build --network=none --pull=false --build-arg "NODE_IMAGE=${node_image}" \
  --file tests/fixtures/container/runtime-resources.Dockerfile \
  --tag "${image_name}" "${runtime_directory}" >"${evidence_directory}/image-build.log" 2>&1

for cpu_count in 1 "${multiple_cpus}"; do
  docker run --rm --pull=never --name "${container_name}" --network=none --cpus="${cpu_count}" --memory=4g \
    "${image_name}" node apps/web/dist-server/server/runtime-resources-probe.mjs \
    >"${evidence_directory}/logs-${cpu_count}cpu.json"
done
node scripts/quality/verify-runtime-resources.mjs \
  "${evidence_directory}/logs-1cpu.json" "${evidence_directory}/logs-${multiple_cpus}cpu.json"

# On a dedicated host, additional memory can support more isolated CPU workers.
docker run --rm --pull=never --name "${container_name}" --network=none --cpus="${multiple_cpus}" \
  "${image_name}" node apps/web/dist-server/server/runtime-resources-probe.mjs \
  >"${evidence_directory}/logs-host-memory.json"
node scripts/quality/verify-runtime-resources.mjs \
  "${evidence_directory}/logs-1cpu.json" "${evidence_directory}/logs-host-memory.json"

# The same packaged image must also complete the real 500-slot Runner HTTP workflow.
chmod 0777 "${protocol_directory}"
docker run --rm --pull=never --network=none --volume "${protocol_directory}:/var/lib/autoforge" \
  "${image_name}" node apps/web/dist-server/server/runtime-resources-probe.mjs configure /var/lib/autoforge
docker run --detach --pull=never --name "${container_name}" --cpus="${multiple_cpus}" --memory=4g \
  --network=host --volume "${protocol_directory}:/var/lib/autoforge" \
  "${image_name}" >/dev/null
node --input-type=module -e '
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/v1/health/ready")).ok) process.exit(0); }
    catch (error) { if (attempt === 119) throw error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Container did not become ready");
'
browser_specs=(tests/e2e/lite-high-concurrency.spec.ts)
if [[ "${acceptance_scope}" == "background" ]]; then
  browser_specs+=(tests/e2e/jar-import.spec.ts tests/e2e/ddt-management.spec.ts tests/e2e/read-model-cache.spec.ts tests/e2e/platform-operations.spec.ts tests/e2e/management-operations.spec.ts)
fi
# Local callback fixtures must be reachable from the container; the app still runs as node.
# Host-created storage fixtures must also be removable by that unprivileged container user.
(
umask 000
AUTOFORGE_E2E_EXTERNAL_SERVER=1 AUTOFORGE_E2E_DATA_DIR="${protocol_directory}" E2E_PROJECT_MAXIMUM_CONCURRENCY=500 E2E_BACKGROUND_LOAD="$([[ "${acceptance_scope}" == "background" ]] && echo 1 || echo 0)" \
  AUTOFORGE_CONCURRENCY_REPORT="${evidence_directory}/protocol.json" \
  pnpm exec playwright test "${browser_specs[@]}" --output="${evidence_directory}/browser"
)
docker inspect "${container_name}" >"${evidence_directory}/container.json"
