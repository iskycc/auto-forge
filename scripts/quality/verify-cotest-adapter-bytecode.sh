#!/usr/bin/env bash

set -Eeuo pipefail

readonly adapter_jar="${1:?usage: verify-cotest-adapter-bytecode.sh ADAPTER_JAR}"
if [[ ! -f "${adapter_jar}" ]]; then
  echo "The CoTest Adapter JAR does not exist: ${adapter_jar}" >&2
  exit 1
fi
for command in unzip od; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "${command} is required to verify CoTest Adapter bytecode." >&2
    exit 1
  fi
done

class_count=0
while IFS= read -r class_entry; do
  read -r major_high major_low < <(
    unzip -p "${adapter_jar}" "${class_entry}" | od -An -t u1 -j 6 -N 2
  )
  class_major_version="$((major_high * 256 + major_low))"
  if ((class_major_version != 52)); then
    echo "${class_entry} has major version ${class_major_version}; expected Java 8 major version 52." >&2
    exit 1
  fi
  class_count=$((class_count + 1))
done < <(unzip -Z1 "${adapter_jar}" | LC_ALL=C sort | grep -E '\.class$')

if ((class_count == 0)); then
  echo "The CoTest Adapter JAR does not contain any class files." >&2
  exit 1
fi

printf 'Verified %d CoTest Adapter classes at Java 8 major version 52.\n' "${class_count}"
