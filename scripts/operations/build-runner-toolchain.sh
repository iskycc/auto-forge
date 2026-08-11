#!/usr/bin/env bash

set -Eeuo pipefail

jdk_directory=""
classpath_directory=""
java_version=""
testng_version="7.11.0"
architecture=""
output_path=""

while (($# > 0)); do
  case "$1" in
    --jdk-dir) jdk_directory="${2:?--jdk-dir requires a directory}"; shift 2 ;;
    --classpath-dir) classpath_directory="${2:?--classpath-dir requires a directory}"; shift 2 ;;
    --java-version) java_version="${2:?--java-version requires a value}"; shift 2 ;;
    --testng-version) testng_version="${2:?--testng-version requires a value}"; shift 2 ;;
    --architecture) architecture="${2:?--architecture requires amd64 or arm64}"; shift 2 ;;
    --output) output_path="${2:?--output requires a file}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${jdk_directory}" || -z "${classpath_directory}" || -z "${java_version}" || -z "${architecture}" || -z "${output_path}" ]]; then
  echo "usage: build-runner-toolchain.sh --jdk-dir DIR --classpath-dir DIR --java-version VERSION --architecture ARCH --output FILE [--testng-version VERSION]" >&2
  exit 2
fi
if [[ "${architecture}" != "amd64" && "${architecture}" != "arm64" ]]; then
  echo "The toolchain architecture must be amd64 or arm64." >&2
  exit 2
fi
if [[ ! -x "${jdk_directory}/bin/java" ]] || ! find "${classpath_directory}" -maxdepth 1 -iname 'testng*.jar' -print -quit | grep -q .; then
  echo "The input must contain an executable bin/java and an offline TestNG JAR classpath." >&2
  exit 2
fi
node - "${jdk_directory}/bin/java" "${architecture}" <<'NODE'
const { readFileSync } = require("node:fs");
const [javaPath, expected] = process.argv.slice(2);
const header = readFileSync(javaPath).subarray(0, 64);
if (header.length < 20 || header[0] !== 0x7f || header.toString("ascii", 1, 4) !== "ELF") {
  throw new Error("JDK bin/java must be a Linux ELF executable.");
}
const littleEndian = header[5] === 1;
const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
const actual = machine === 62 ? "amd64" : machine === 183 ? "arm64" : "unsupported";
if (actual !== expected) throw new Error(`JDK architecture ${actual} does not match ${expected}.`);
NODE

readonly staging_directory="$(mktemp -d)"
cleanup() { rm -rf -- "${staging_directory}"; }
trap cleanup EXIT
readonly root="${staging_directory}/autoforge-runner-toolchain"
mkdir -p -- "${root}/jdk" "${root}/lib"
cp -a -- "${jdk_directory}/." "${root}/jdk/"
cp -a -- "${classpath_directory}/." "${root}/lib/"
(
  cd -- "${root}"
  find jdk lib -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >file-sha256sums
)
node - "${root}/manifest.json" "${java_version}" "${testng_version}" "${architecture}" <<'NODE'
const { writeFileSync } = require("node:fs");
const [output, javaVersion, testNgVersion, architecture] = process.argv.slice(2);
writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  platform: "linux",
  architecture,
  javaVersion,
  testNgVersion,
  javaExecutable: "jdk/bin/java",
  classpathGlob: "lib/*.jar",
  fileIntegrityManifest: "file-sha256sums",
  runtimeDownloadsAllowed: false,
}, null, 2)}\n`);
NODE
mkdir -p -- "$(dirname -- "${output_path}")"
tar \
  --sort=name \
  --mtime="@${SOURCE_DATE_EPOCH:-0}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --pax-option=delete=atime,delete=ctime \
  --create \
  --file=- \
  --directory="${staging_directory}" \
  autoforge-runner-toolchain | gzip -n >"${output_path}"
(
  cd -- "$(dirname -- "${output_path}")"
  sha256sum -- "$(basename -- "${output_path}")" >"$(basename -- "${output_path}").sha256"
)
printf 'Created offline Runner toolchain: %s\n' "${output_path}"
