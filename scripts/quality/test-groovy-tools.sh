#!/usr/bin/env bash

set -Eeuo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly groovy_tool_directory="${repository_root}/groovy-test"

mvn --batch-mode \
  --file "${groovy_tool_directory}/pom.xml" \
  clean compile dependency:copy-dependencies

readonly poi_classpath="$(
  find "${groovy_tool_directory}/target/dependency" \
    -name '*.jar' \
    -type f \
    -printf '%p:' \
    | sed 's/:$//'
)"

POI_CLASSPATH="${poi_classpath}" \
  bash "${groovy_tool_directory}/analyze-normal-groovy-cases.test.sh"
bash "${groovy_tool_directory}/apply-groovy-case-groups.test.sh"
