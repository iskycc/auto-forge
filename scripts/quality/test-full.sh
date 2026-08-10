#!/usr/bin/env bash

set -Eeuo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly temporary_directory="$(mktemp -d)"
readonly postgres_container="autoforge-full-postgres-$$"
readonly redis_container="autoforge-full-redis-$$"
readonly postgres_image="postgres:15-alpine@sha256:df7bca0066e6f60cc3dd32faa70caddec20e2c22b58932f79498e5704b23854a"
readonly redis_image="redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99"
readonly nats_archive_sha256="f3d0c820c749f81d717310fb00d4903919e70e3e66b268bd352a088b9788eb93"
readonly minio_binary_sha256="53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c"
readonly readiness_attempts=240

nats_pid=""
minio_pid=""
web_pid=""
worker_pid=""

cleanup() {
  set +e
  if [[ -n "${web_pid}" ]]; then
    terminate_process_group "${web_pid}"
  fi
  if [[ -n "${worker_pid}" ]]; then
    terminate_process_group "${worker_pid}"
  fi
  for process_id in "${minio_pid}" "${nats_pid}"; do
    if [[ -n "${process_id}" ]]; then
      kill "${process_id}" >/dev/null 2>&1
      wait "${process_id}" >/dev/null 2>&1
    fi
  done
  docker rm --force "${postgres_container}" "${redis_container}" >/dev/null 2>&1
  rm -rf -- "${temporary_directory}"
}
trap cleanup EXIT

terminate_process_group() {
  local group_leader="${1}"
  kill -TERM -- "-${group_leader}" >/dev/null 2>&1
  for _ in $(seq 1 50); do
    if ! kill -0 -- "-${group_leader}" >/dev/null 2>&1; then
      wait "${group_leader}" >/dev/null 2>&1
      return
    fi
    sleep 0.1
  done
  kill -KILL -- "-${group_leader}" >/dev/null 2>&1
  wait "${group_leader}" >/dev/null 2>&1
}

wait_until() {
  local description="${1}"
  shift
  for _ in $(seq 1 "${readiness_attempts}"); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  printf 'Timed out waiting for %s.\n' "${description}" >&2
  return 1
}

download_dependencies() {
  curl --fail --location --silent --show-error \
    "https://github.com/nats-io/nats-server/releases/download/v2.14.3/nats-server-v2.14.3-linux-amd64.tar.gz" \
    --output "${temporary_directory}/nats.tar.gz"
  printf '%s  %s\n' "${nats_archive_sha256}" "${temporary_directory}/nats.tar.gz" | sha256sum --check --status
  tar -xzf "${temporary_directory}/nats.tar.gz" -C "${temporary_directory}"

  curl --fail --location --silent --show-error \
    "https://github.com/minio/minio/releases/download/RELEASE.2025-04-22T22-12-26Z/minio.linux-amd64.RELEASE.2025-04-22T22-12-26Z" \
    --output "${temporary_directory}/minio"
  printf '%s  %s\n' "${minio_binary_sha256}" "${temporary_directory}/minio" | sha256sum --check --status
  chmod 0755 "${temporary_directory}/minio"
}

start_dependencies() {
  docker run --detach \
    --name "${postgres_container}" \
    --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m \
    --publish 127.0.0.1:55439:5432 \
    --env POSTGRES_DB=autoforge \
    --env POSTGRES_USER=autoforge \
    --env POSTGRES_PASSWORD=autoforge \
    "${postgres_image}" >/dev/null
  docker run --detach \
    --name "${redis_container}" \
    --tmpfs /data:rw,noexec,nosuid,size=64m \
    --publish 127.0.0.1:56389:6379 \
    "${redis_image}" redis-server --save '' --appendonly no >/dev/null

  mkdir -p "${temporary_directory}/nats-data" "${temporary_directory}/minio-data"
  "${temporary_directory}/nats-server-v2.14.3-linux-amd64/nats-server" \
    --jetstream \
    --store_dir "${temporary_directory}/nats-data" \
    --addr 127.0.0.1 \
    --port 54229 >"${temporary_directory}/nats.log" 2>&1 &
  nats_pid="$!"
  MINIO_ROOT_USER=autoforge MINIO_ROOT_PASSWORD=autoforge-secret \
    "${temporary_directory}/minio" server "${temporary_directory}/minio-data" \
    --address 127.0.0.1:59009 \
    --console-address 127.0.0.1:59010 >"${temporary_directory}/minio.log" 2>&1 &
  minio_pid="$!"

  wait_until PostgreSQL docker exec "${postgres_container}" pg_isready -U autoforge -d autoforge
  wait_until Redis docker exec "${redis_container}" redis-cli ping
  wait_until NATS bash -c "exec 3<>/dev/tcp/127.0.0.1/54229"
  wait_until MinIO curl --fail --silent http://127.0.0.1:59009/minio/health/live
}

run_adapter_tests() {
  AUTOFORGE_TEST_POSTGRES_URL=postgresql://autoforge:autoforge@127.0.0.1:55439/autoforge \
  AUTOFORGE_TEST_MINIO_ENDPOINT=http://127.0.0.1:59009 \
  AUTOFORGE_TEST_MINIO_ACCESS_KEY=autoforge \
  AUTOFORGE_TEST_MINIO_SECRET_KEY=autoforge-secret \
  AUTOFORGE_TEST_NATS_URL=nats://127.0.0.1:54229 \
    pnpm exec vitest run \
      packages/db/test/postgres-platform.integration.test.ts \
      packages/object-store/test/minio-object-store.integration.test.ts \
      packages/queue/test/jetstream-job-queue.integration.test.ts
}

create_platform_bucket() {
  pnpm --filter @autoforge/object-store exec node --input-type=module -e \
    "import { Client } from 'minio'; const client = new Client({endPoint:'127.0.0.1',port:59009,useSSL:false,accessKey:'autoforge',secretKey:'autoforge-secret'}); if (!(await client.bucketExists('autoforge-objects'))) await client.makeBucket('autoforge-objects','us-east-1');"
}

start_full_platform() {
  # Keep pnpm and the spawned Next server in one isolated group so cleanup releases the dev lock.
  AUTOFORGE_MODE=full \
  AUTOFORGE_DATABASE_URL=postgresql://autoforge:autoforge@127.0.0.1:55439/autoforge \
  AUTOFORGE_NATS_SERVERS=nats://127.0.0.1:54229 \
  AUTOFORGE_REDIS_URL=redis://127.0.0.1:56389 \
  AUTOFORGE_MINIO_ENDPOINT=http://127.0.0.1:59009 \
  AUTOFORGE_MINIO_ACCESS_KEY=autoforge \
  AUTOFORGE_MINIO_SECRET_KEY=autoforge-secret \
  AUTOFORGE_MINIO_BUCKET=autoforge-objects \
  AUTOFORGE_MINIO_REGION=us-east-1 \
  AUTOFORGE_RUNNER_BOOTSTRAP_TOKEN=full-ci-bootstrap-token-000000000000 \
  AUTOFORGE_ADMIN_BOOTSTRAP_TOKEN=full-ci-admin-bootstrap-token-000000000000 \
  AUTOFORGE_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  HOSTNAME=127.0.0.1 \
  PORT=3199 \
    setsid pnpm --filter @autoforge/web dev \
    >"${temporary_directory}/web.log" 2>&1 &
  web_pid="$!"
  wait_until "Full platform" curl --fail --silent http://127.0.0.1:3199/api/v1/health/ready
}

start_full_worker() {
  pnpm --filter @autoforge/worker build >/dev/null
  AUTOFORGE_DATABASE_URL=postgresql://autoforge:autoforge@127.0.0.1:55439/autoforge \
  AUTOFORGE_NATS_SERVERS=nats://127.0.0.1:54229 \
  AUTOFORGE_WORKER_ID=full-ci-worker \
  AUTOFORGE_WORKER_HEALTH_PORT=3201 \
  AUTOFORGE_POSTGRES_MIGRATIONS_DIR="${repository_root}/packages/db/drizzle/postgresql" \
    setsid node apps/worker/dist/worker.mjs \
    >"${temporary_directory}/worker.log" 2>&1 &
  worker_pid="$!"
  wait_until "Full worker" curl --fail --silent http://127.0.0.1:3201/health/ready
}

verify_runner_registration() {
  local request='{"schemaVersion":1,"name":"full-ci-runner","labels":["full"],"maxConcurrency":1,"os":"linux","architecture":"amd64","agentVersion":"ci","protocolVersion":1,"terminalEnabled":false}'
  local first_status
  local second_status
  first_status="$(curl --silent --output "${temporary_directory}/registration.json" --write-out '%{http_code}' \
    --request POST http://127.0.0.1:3199/api/v1/runner-agents/register \
    --header 'Authorization: Bearer full-ci-bootstrap-token-000000000000' \
    --header 'Content-Type: application/json' \
    --data "${request}")"
  second_status="$(curl --silent --output "${temporary_directory}/duplicate.json" --write-out '%{http_code}' \
    --request POST http://127.0.0.1:3199/api/v1/runner-agents/register \
    --header 'Authorization: Bearer full-ci-bootstrap-token-000000000000' \
    --header 'Content-Type: application/json' \
    --data "${request}")"
  [[ "${first_status}" == "201" && "${second_status}" == "403" ]]
}

cd "${repository_root}"
download_dependencies
start_dependencies
run_adapter_tests
create_platform_bucket
start_full_worker
start_full_platform
verify_runner_registration
printf 'Full mode integration passed.\n'
