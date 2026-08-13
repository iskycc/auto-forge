#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Release toolchain assets are built only in GitHub Actions." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly version="${1:?usage: build-runner-toolchain-asset.sh VERSION ARCH OUTPUT_DIR SBOM_ROOT}"
readonly architecture="${2:?usage: build-runner-toolchain-asset.sh VERSION ARCH OUTPUT_DIR SBOM_ROOT}"
readonly output_directory="${3:?usage: build-runner-toolchain-asset.sh VERSION ARCH OUTPUT_DIR SBOM_ROOT}"
readonly sbom_root="${4:?usage: build-runner-toolchain-asset.sh VERSION ARCH OUTPUT_DIR SBOM_ROOT}"
readonly java_image="eclipse-temurin:21.0.8_9-jre-noble@sha256:20e7f7288e1c18eebe8f06a442c9f7183342d9b022d3b9a9677cae2b558ddddd"
readonly temporary_directory="$(mktemp -d)"
container_id=""

cleanup() {
  local exit_status="$?"
  set +e
  if [[ -n "${container_id}" ]]; then docker rm --force "${container_id}" >/dev/null 2>&1; fi
  rm -rf -- "${temporary_directory}"
  return "${exit_status}"
}
trap cleanup EXIT

case "${architecture}" in
  amd64) readonly docker_architecture="amd64" ;;
  arm64) readonly docker_architecture="arm64" ;;
  *) echo "Unsupported toolchain architecture: ${architecture}" >&2; exit 2 ;;
esac

download_verified() {
  local url="${1:?download URL is required}"
  local expected_sha256="${2:?SHA-256 is required}"
  local output_path="${3:?output path is required}"
  curl --fail --location --silent --show-error "${url}" --output "${output_path}"
  printf '%s  %s\n' "${expected_sha256}" "${output_path}" | sha256sum --check --status
}

mkdir -p "${temporary_directory}/classpath" "${output_directory}" "${sbom_root}"
docker pull --platform "linux/${docker_architecture}" "${java_image}" >/dev/null
container_id="$(docker create --platform "linux/${docker_architecture}" "${java_image}")"
docker cp "${container_id}:/opt/java/openjdk" "${temporary_directory}/jdk"
docker rm "${container_id}" >/dev/null
container_id=""

download_verified \
  "https://repo.maven.apache.org/maven2/org/testng/testng/7.11.0/testng-7.11.0.jar" \
  "2edbe6b2211186d8f5439cba7998697cce883432e5f14e0696f6b59d0d58582b" \
  "${temporary_directory}/classpath/testng-7.11.0.jar"
download_verified \
  "https://repo.maven.apache.org/maven2/org/jcommander/jcommander/1.83/jcommander-1.83.jar" \
  "e65f49c2119a1859b9076061e561fb5958a2fa6ffdb49f051ca8d59a0b3f87e4" \
  "${temporary_directory}/classpath/jcommander-1.83.jar"
download_verified \
  "https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar" \
  "a12578dde1ba00bd9b816d388a0b879928d00bab3c83c240f7013bf4196c579a" \
  "${temporary_directory}/classpath/slf4j-api-2.0.16.jar"
download_verified \
  "https://repo.maven.apache.org/maven2/org/webjars/jquery/3.7.1/jquery-3.7.1.jar" \
  "262016dd3a559df87aefbe392804e9bf620787c9204c0ab8522d4c231ea65097" \
  "${temporary_directory}/classpath/jquery-3.7.1.jar"

readonly java_version="$("${temporary_directory}/jdk/bin/java" -XshowSettings:properties -version 2>&1 | awk -F'= ' '/java.version =/{print $2; exit}')"
readonly asset_name="autoforge-runner-toolchain-linux-${architecture}-java21-testng7.11.0.tar.gz"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" \
  bash "${repository_root}/scripts/operations/build-runner-toolchain.sh" \
    --jdk-dir "${temporary_directory}/jdk" \
    --classpath-dir "${temporary_directory}/classpath" \
    --java-version "${java_version}" \
    --testng-version 7.11.0 \
    --architecture "${architecture}" \
    --output "${output_directory}/${asset_name}"

tar -xzf "${output_directory}/${asset_name}" -C "${sbom_root}"
printf 'Built offline Runner toolchain %s for AutoForge %s.\n' "${asset_name}" "${version}"
