#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Full acceptance is restricted to GitHub Actions because it builds production bundles and runs privileged infrastructure fault injection." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly temporary_directory="$(mktemp -d)"
readonly acceptance_phase="${1:-all}"
readonly postgres_container="autoforge-full-postgres-$$"
readonly redis_container="autoforge-full-redis-$$"
readonly postgres_image="postgres:15-alpine@sha256:df7bca0066e6f60cc3dd32faa70caddec20e2c22b58932f79498e5704b23854a"
readonly redis_image="redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99"
readonly nats_archive_sha256="f3d0c820c749f81d717310fb00d4903919e70e3e66b268bd352a088b9788eb93"
readonly minio_binary_sha256="53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c"
readonly readiness_attempts=240
readonly platform_data_directory="${temporary_directory}/platform-data"
readonly replica_platform_data_directory="${temporary_directory}/platform-replica-data"
readonly platform_configuration_input="${temporary_directory}/platform-input.json"
readonly fault_control_directory="${temporary_directory}/fault-control"

nats_pid=""
minio_pid=""
minio_proxy_pid=""
fault_controller_pid=""
web_pid=""
web_replica_pid=""
worker_pid=""
worker_replica_pid=""

cleanup() {
  local exit_status="$?"
  set +e
  mkdir -p "${fault_control_directory}"
  touch "${fault_control_directory}/stop" "${fault_control_directory}/nats.resume" \
    "${fault_control_directory}/postgres.resume" "${fault_control_directory}/redis.resume"
  if [[ -n "${nats_pid}" ]]; then
    kill -CONT "${nats_pid}" >/dev/null 2>&1
  fi
  docker unpause "${postgres_container}" "${redis_container}" >/dev/null 2>&1
  if [[ -n "${fault_controller_pid}" ]]; then
    wait "${fault_controller_pid}" >/dev/null 2>&1
  fi
  if [[ "${exit_status}" -ne 0 ]]; then
    for diagnostic_log in web-build web web-replica worker worker-replica nats minio minio-proxy fault-controller; do
      if [[ -f "${temporary_directory}/${diagnostic_log}.log" ]]; then
        echo "=== ${diagnostic_log}.log (last 400 lines) ===" >&2
        tail -n 400 "${temporary_directory}/${diagnostic_log}.log" >&2
      fi
    done
  fi
  for process_id in "${web_pid}" "${web_replica_pid}" "${worker_pid}" "${worker_replica_pid}"; do
    if [[ -n "${process_id}" ]]; then
      terminate_process_group "${process_id}"
    fi
  done
  for process_id in "${minio_pid}" "${nats_pid}"; do
    if [[ -n "${process_id}" ]]; then
      kill "${process_id}" >/dev/null 2>&1
      wait "${process_id}" >/dev/null 2>&1
    fi
  done
  if [[ -n "${minio_proxy_pid}" ]]; then
    kill "${minio_proxy_pid}" >/dev/null 2>&1
    wait "${minio_proxy_pid}" >/dev/null 2>&1
  fi
  docker rm --force "${postgres_container}" "${redis_container}" >/dev/null 2>&1
  rm -rf -- "${temporary_directory}"
  return "${exit_status}"
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

wait_until_unready() {
  local description="${1}"
  local url="${2}"
  for _ in $(seq 1 "${readiness_attempts}"); do
    if ! curl --fail --silent --max-time 2 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  printf 'Timed out waiting for %s to report not ready.\n' "${description}" >&2
  return 1
}

start_nats() {
  "${temporary_directory}/nats-server-v2.14.3-linux-amd64/nats-server" \
    --jetstream \
    --store_dir "${temporary_directory}/nats-data" \
    --addr 127.0.0.1 \
    --port 54229 >>"${temporary_directory}/nats.log" 2>&1 &
  nats_pid="$!"
  wait_until NATS bash -c "exec 3<>/dev/tcp/127.0.0.1/54229"
}

stop_nats() {
  kill "${nats_pid}"
  wait "${nats_pid}" || true
  nats_pid=""
}

start_minio() {
  MINIO_ROOT_USER=autoforge MINIO_ROOT_PASSWORD=autoforge-secret \
    "${temporary_directory}/minio" server "${temporary_directory}/minio-data" \
    --address 127.0.0.1:59011 \
    --console-address 127.0.0.1:59010 >>"${temporary_directory}/minio.log" 2>&1 &
  minio_pid="$!"
  wait_until MinIO curl --fail --silent http://127.0.0.1:59011/minio/health/live
}

stop_minio() {
  kill "${minio_pid}"
  wait "${minio_pid}" || true
  minio_pid=""
}

start_minio_proxy() {
  node "${repository_root}/scripts/quality/minio-fault-proxy.mjs" \
    "${fault_control_directory}" 59009 59011 \
    >>"${temporary_directory}/minio-proxy.log" 2>&1 &
  minio_proxy_pid="$!"
  wait_until "MinIO fault proxy" curl --fail --silent http://127.0.0.1:59009/minio/health/live
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
    --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1g \
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

  mkdir -p "${temporary_directory}/nats-data" "${temporary_directory}/minio-data" \
    "${fault_control_directory}"
  wait_until PostgreSQL docker exec "${postgres_container}" pg_isready -U autoforge -d autoforge
  wait_until Redis docker exec "${redis_container}" redis-cli ping
  start_nats
  start_minio
  start_minio_proxy
}

start_fault_controller() {
  (
    set -Eeuo pipefail
    while [[ ! -f "${fault_control_directory}/stop" ]]; do
      if [[ -f "${fault_control_directory}/nats.pause" ]]; then
        rm -- "${fault_control_directory}/nats.pause"
        kill -STOP "${nats_pid}"
        touch "${fault_control_directory}/nats.paused"
        while [[ ! -f "${fault_control_directory}/nats.resume" && ! -f "${fault_control_directory}/stop" ]]; do sleep 0.05; done
        kill -CONT "${nats_pid}" >/dev/null 2>&1 || true
        rm -f -- "${fault_control_directory}/nats.resume"
        touch "${fault_control_directory}/nats.resumed"
      fi
      if [[ -f "${fault_control_directory}/postgres.pause" ]]; then
        rm -- "${fault_control_directory}/postgres.pause"
        docker pause "${postgres_container}" >/dev/null
        touch "${fault_control_directory}/postgres.paused"
        while [[ ! -f "${fault_control_directory}/postgres.resume" && ! -f "${fault_control_directory}/stop" ]]; do sleep 0.05; done
        docker unpause "${postgres_container}" >/dev/null 2>&1 || true
        rm -f -- "${fault_control_directory}/postgres.resume"
        touch "${fault_control_directory}/postgres.resumed"
      fi
      if [[ -f "${fault_control_directory}/redis.pause" ]]; then
        rm -- "${fault_control_directory}/redis.pause"
        docker pause "${redis_container}" >/dev/null
        touch "${fault_control_directory}/redis.paused"
        while [[ ! -f "${fault_control_directory}/redis.resume" && ! -f "${fault_control_directory}/stop" ]]; do sleep 0.05; done
        docker unpause "${redis_container}" >/dev/null 2>&1 || true
        rm -f -- "${fault_control_directory}/redis.resume"
        touch "${fault_control_directory}/redis.resumed"
      fi
      sleep 0.05
    done
  ) >>"${temporary_directory}/fault-controller.log" 2>&1 &
  fault_controller_pid="$!"
}

stop_fault_controller() {
  touch "${fault_control_directory}/stop"
  for dependency in nats postgres redis; do
    touch "${fault_control_directory}/${dependency}.resume"
  done
  wait "${fault_controller_pid}"
  fault_controller_pid=""
}

run_adapter_tests() {
  AUTOFORGE_TEST_POSTGRES_URL=postgresql://autoforge:autoforge@127.0.0.1:55439/autoforge \
  AUTOFORGE_TEST_MINIO_ENDPOINT=http://127.0.0.1:59009 \
  AUTOFORGE_TEST_MINIO_ACCESS_KEY=autoforge \
  AUTOFORGE_TEST_MINIO_SECRET_KEY=autoforge-secret \
  AUTOFORGE_TEST_NATS_URL=nats://127.0.0.1:54229 \
    pnpm exec vitest run \
      packages/db/test/postgres-migrations.integration.test.ts \
      packages/db/test/postgres-ddt.integration.test.ts \
      packages/db/test/postgres-failure-analysis.integration.test.ts \
      packages/db/test/postgres-platform.integration.test.ts \
      packages/db/test/postgres-round-recovery.integration.test.ts \
      packages/db/test/postgres-webhook.integration.test.ts \
      packages/db/test/postgres-runner-group.integration.test.ts \
      packages/db/test/postgres-runner-installation-profile.integration.test.ts \
      packages/db/test/scheduling-refill.integration.test.ts \
      packages/object-store/test/minio-object-store.integration.test.ts \
      packages/queue/test/jetstream-job-queue.integration.test.ts
}

run_capacity_tests() {
  AUTOFORGE_TEST_POSTGRES_URL=postgresql://autoforge:autoforge@127.0.0.1:55439/autoforge \
    pnpm exec vitest run packages/db/test/postgres-capacity.integration.test.ts
}

create_platform_bucket() {
  pnpm --filter @autoforge/object-store exec node --input-type=module -e \
    "import { Client } from 'minio'; const client = new Client({endPoint:'127.0.0.1',port:59009,useSSL:false,accessKey:'autoforge',secretKey:'autoforge-secret'}); if (!(await client.bucketExists('autoforge-objects'))) await client.makeBucket('autoforge-objects','us-east-1');"
}

initialize_platform_configuration() {
  node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    import { MAXIMUM_JAR_UPLOAD_BYTES } from "./packages/platform-config/src/platform-configuration.ts";
    const [path] = process.argv.slice(1);
    writeFileSync(path, `${JSON.stringify({
      revision: 1,
      mode: "full",
      web: {
        hostname: "127.0.0.1",
        port: 3199,
        publicBaseUrl: "http://127.0.0.1:3199",
        publicDashboardRefreshSeconds: 5,
      },
      limits: {
        maxJarBytes: MAXIMUM_JAR_UPLOAD_BYTES,
        testNgTargetJavaVersion: 21,
        runnerClaimRateLimitPerMinute: 120,
        sessionTtlHours: 12,
        authLoginAttemptsPerWindow: 500,
      },
      scheduler: {
        maximumCpuUtilizationPercent: 85,
        maximumMemoryUtilizationPercent: 85,
        maximumLoadPerCpu: 1,
        metricsMaximumAgeSeconds: 45,
        projectMaximumConcurrency: 1,
        priorityAgingIntervalMinutes: 5,
      },
      worker: {
        concurrency: 4,
        healthPort: 3201,
        metricsEnabled: false,
        shutdownGraceMs: 30000,
      },
      full: {
        databaseUrl: "postgresql://autoforge:autoforge@127.0.0.1:55439/autoforge",
        natsServers: ["nats://127.0.0.1:54229"],
        redisUrl: "redis://127.0.0.1:56389",
        minio: {
          endpoint: "http://127.0.0.1:59009",
          accessKey: "autoforge",
          secretKey: "autoforge-secret",
          bucket: "autoforge-objects",
          region: "us-east-1",
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });
  ' "${platform_configuration_input}"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { PlatformConfigurationStore } from "./packages/platform-config/src/platform-configuration.ts";
    const [dataDirectory, inputPath] = process.argv.slice(1);
    const store = new PlatformConfigurationStore(dataDirectory);
    const current = store.initialize();
    const input = JSON.parse(readFileSync(inputPath, "utf8"));
    store.replace({ ...current, ...input, revision: current.revision }, current.revision);
  ' "${platform_data_directory}" "${platform_configuration_input}"

  cp -R -- "${platform_data_directory}" "${replica_platform_data_directory}"
  node --input-type=module -e '
    import { PlatformConfigurationStore } from "./packages/platform-config/src/platform-configuration.ts";
    const [dataDirectory] = process.argv.slice(1);
    const store = new PlatformConfigurationStore(dataDirectory);
    const current = store.initialize();
    store.replace({
      ...current,
      web: {
        ...current.web,
        port: 3198,
        publicBaseUrl: "http://127.0.0.1:3198",
      },
      worker: {
        ...current.worker,
        healthPort: 3202,
      },
    }, current.revision);
  ' "${replica_platform_data_directory}"
}

start_full_platform() {
  pnpm --filter @autoforge/web build >"${temporary_directory}/web-build.log" 2>&1
  # Keep the production server in one isolated group so cleanup releases every connection.
  NODE_ENV=production setsid node apps/web/dist-server/server/index.js \
    --data-dir="${platform_data_directory}" \
    >"${temporary_directory}/web.log" 2>&1 &
  web_pid="$!"
  wait_until "Full platform" curl --fail --silent http://127.0.0.1:3199/api/v1/health/ready
  NODE_ENV=production setsid node apps/web/dist-server/server/index.js \
    --data-dir="${replica_platform_data_directory}" \
    >"${temporary_directory}/web-replica.log" 2>&1 &
  web_replica_pid="$!"
  wait_until "Full platform replica" curl --fail --silent http://127.0.0.1:3198/api/v1/health/ready
}

start_full_worker() {
  pnpm --filter @autoforge/worker build >/dev/null
  setsid node apps/worker/dist/worker.mjs --data-dir="${platform_data_directory}" \
    >"${temporary_directory}/worker.log" 2>&1 &
  worker_pid="$!"
  wait_until "Full worker" curl --fail --silent http://127.0.0.1:3201/health/ready
  setsid node apps/worker/dist/worker.mjs --data-dir="${replica_platform_data_directory}" \
    >"${temporary_directory}/worker-replica.log" 2>&1 &
  worker_replica_pid="$!"
  wait_until "Full worker replica" curl --fail --silent http://127.0.0.1:3202/health/ready
}

run_full_browser_flow() {
  local browser_phase="${1:?Full browser phase is required}"
  local browser_specs=()
  case "${browser_phase}" in
    assets)
      browser_specs=(
        tests/e2e/case-suite-lifecycle.spec.ts
        tests/e2e/jar-import.spec.ts
        tests/e2e/project-isolation.spec.ts
      )
      ;;
    governance)
      browser_specs=(
        tests/e2e/identity-rbac.spec.ts
        tests/e2e/management-operations.spec.ts
        tests/e2e/platform-operations.spec.ts
      )
      ;;
    recovery)
      browser_specs=(tests/e2e/execution-recovery.spec.ts)
      ;;
    all)
      browser_specs=(
        tests/e2e/case-suite-lifecycle.spec.ts
        tests/e2e/execution-recovery.spec.ts
        tests/e2e/identity-rbac.spec.ts
        tests/e2e/jar-import.spec.ts
        tests/e2e/management-operations.spec.ts
        tests/e2e/platform-operations.spec.ts
        tests/e2e/project-isolation.spec.ts
      )
      ;;
    *)
      printf 'Unknown Full browser phase: %s\n' "${browser_phase}" >&2
      return 2
      ;;
  esac
  local admin_bootstrap_token
  local runner_bootstrap_master_key
  local runner_bootstrap_token
  admin_bootstrap_token="$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets.adminBootstrapToken" \
    "${platform_data_directory}/config/platform.json")"
  runner_bootstrap_token="$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets.runnerBootstrapToken" \
    "${platform_data_directory}/config/platform.json")"
  runner_bootstrap_master_key="$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets.masterKey" \
    "${platform_data_directory}/config/platform.json")"
  E2E_BASE_URL=http://127.0.0.1:3199 \
  E2E_SECONDARY_BASE_URL=http://127.0.0.1:3198 \
  E2E_ADMIN_BOOTSTRAP_TOKEN="${admin_bootstrap_token}" \
  E2E_RUNNER_BOOTSTRAP_TOKEN="${runner_bootstrap_token}" \
  E2E_RUNNER_BOOTSTRAP_MASTER_KEY="${runner_bootstrap_master_key}" \
  AUTOFORGE_E2E_POSTGRES_URL=postgresql://autoforge:autoforge@127.0.0.1:55439/autoforge \
    pnpm exec playwright test \
      --config playwright.full.config.ts \
      "${browser_specs[@]}"
}

run_full_real_agent_recovery() {
  local admin_bootstrap_token
  local runner_bootstrap_token
  admin_bootstrap_token="$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets.adminBootstrapToken" \
    "${platform_data_directory}/config/platform.json")"
  runner_bootstrap_token="$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets.runnerBootstrapToken" \
    "${platform_data_directory}/config/platform.json")"
  start_fault_controller
  E2E_REAL_AGENT_EXTERNAL_BASE_URL=http://127.0.0.1:3199 \
  E2E_ADMIN_BOOTSTRAP_TOKEN="${admin_bootstrap_token}" \
  E2E_RUNNER_BOOTSTRAP_TOKEN="${runner_bootstrap_token}" \
  E2E_FULL_FAULT_CONTROL_DIR="${fault_control_directory}" \
    bash "${repository_root}/scripts/quality/test-real-agent.sh"
  stop_fault_controller
}

run_full_ldap_flow() {
  local admin_bootstrap_token
  admin_bootstrap_token="$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets.adminBootstrapToken" \
    "${platform_data_directory}/config/platform.json")"
  E2E_LDAP_EXTERNAL_BASE_URL=http://127.0.0.1:3199 \
  E2E_LDAP_EXTERNAL_DIRECTORY_HOST=127.0.0.1 \
  E2E_LDAP_LDAPS_PORT=5636 \
  E2E_LDAP_PLAIN_PORT=5389 \
  E2E_ADMIN_BOOTSTRAP_TOKEN="${admin_bootstrap_token}" \
    bash "${repository_root}/scripts/quality/test-ldap-e2e.sh"
}

verify_dependency_recovery() {
  printf 'Verifying Redis interruption and recovery...\n'
  docker stop --time 1 "${redis_container}" >/dev/null
  wait_until_unready "primary Web after Redis interruption" \
    http://127.0.0.1:3199/api/v1/health/ready
  wait_until_unready "replica Web after Redis interruption" \
    http://127.0.0.1:3198/api/v1/health/ready
  docker start "${redis_container}" >/dev/null
  wait_until Redis docker exec "${redis_container}" redis-cli ping
  wait_until "primary Web after Redis recovery" curl --fail --silent \
    http://127.0.0.1:3199/api/v1/health/ready
  wait_until "replica Web after Redis recovery" curl --fail --silent \
    http://127.0.0.1:3198/api/v1/health/ready

  printf 'Verifying MinIO interruption and recovery...\n'
  stop_minio
  wait_until_unready "primary Web after MinIO interruption" \
    http://127.0.0.1:3199/api/v1/health/ready
  wait_until_unready "primary worker after MinIO interruption" \
    http://127.0.0.1:3201/health/ready
  start_minio
  wait_until "primary Web after MinIO recovery" curl --fail --silent \
    http://127.0.0.1:3199/api/v1/health/ready
  wait_until "primary worker after MinIO recovery" curl --fail --silent \
    http://127.0.0.1:3201/health/ready

  printf 'Verifying NATS interruption and recovery...\n'
  stop_nats
  wait_until_unready "primary Web after NATS interruption" \
    http://127.0.0.1:3199/api/v1/health/ready
  wait_until_unready "primary worker after NATS interruption" \
    http://127.0.0.1:3201/health/ready
  start_nats
  wait_until "primary Web after NATS recovery" curl --fail --silent \
    http://127.0.0.1:3199/api/v1/health/ready
  wait_until "primary worker after NATS recovery" curl --fail --silent \
    http://127.0.0.1:3201/health/ready

  printf 'Verifying PostgreSQL interruption and recovery...\n'
  # PostgreSQL uses a tmpfs fixture. pause/unpause simulates a network/service
  # stall without turning a transient recovery test into intentional data loss.
  docker pause "${postgres_container}" >/dev/null
  wait_until_unready "primary Web after PostgreSQL interruption" \
    http://127.0.0.1:3199/api/v1/health/ready
  wait_until_unready "primary worker after PostgreSQL interruption" \
    http://127.0.0.1:3201/health/ready
  docker unpause "${postgres_container}" >/dev/null
  wait_until PostgreSQL docker exec "${postgres_container}" pg_isready -U autoforge -d autoforge
  wait_until "primary Web after PostgreSQL recovery" curl --fail --silent \
    http://127.0.0.1:3199/api/v1/health/ready
  wait_until "primary worker after PostgreSQL recovery" curl --fail --silent \
    http://127.0.0.1:3201/health/ready
}

cd "${repository_root}"
download_dependencies
start_dependencies

case "${acceptance_phase}" in
  contracts)
    run_capacity_tests
    run_adapter_tests
    ;;
  browser-assets | browser-governance | browser-recovery | real-agent | ldap | dependency-recovery | runtime-agent | runtime-recovery | runtime-health | all)
    case "${acceptance_phase}" in
      runtime-health | all)
        run_capacity_tests
        run_adapter_tests
        ;;
    esac
    create_platform_bucket
    initialize_platform_configuration
    start_full_worker
    start_full_platform
    case "${acceptance_phase}" in
      browser-assets)
        run_full_browser_flow assets
        ;;
      browser-governance)
        run_full_browser_flow governance
        ;;
      browser-recovery)
        run_full_browser_flow recovery
        ;;
      real-agent)
        run_full_real_agent_recovery
        ;;
      ldap)
        run_full_ldap_flow
        ;;
      dependency-recovery)
        verify_dependency_recovery
        ;;
      runtime-agent)
        run_full_real_agent_recovery
        ;;
      runtime-recovery)
        run_full_browser_flow recovery
        run_full_ldap_flow
        verify_dependency_recovery
        ;;
      runtime-health)
        run_full_real_agent_recovery
        run_full_ldap_flow
        verify_dependency_recovery
        ;;
      all)
        run_full_browser_flow all
        run_full_real_agent_recovery
        run_full_ldap_flow
        verify_dependency_recovery
        ;;
    esac
    ;;
  *)
    printf 'Unknown Full acceptance phase: %s\n' "${acceptance_phase}" >&2
    exit 2
    ;;
esac

printf 'Full mode acceptance phase passed: %s.\n' "${acceptance_phase}"
