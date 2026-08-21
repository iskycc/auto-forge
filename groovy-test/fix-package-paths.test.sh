#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_path="${repository_root}/groovy-test/FixPackagePaths.groovy"

fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT
compiled_classes="${fixture_root}/classes"
mkdir -p "${compiled_classes}"

compile_fixer() {
  if [[ -n "${GROOVY_JAR:-}" ]]; then
    java -cp "${GROOVY_JAR}" org.codehaus.groovy.tools.FileSystemCompiler \
      -d "${compiled_classes}" "${script_path}"
  elif command -v groovyc >/dev/null 2>&1; then
    groovyc -d "${compiled_classes}" "${script_path}"
  else
    echo 'Install Groovy or set GROOVY_JAR to run this test.' >&2
    return 1
  fi
}

run_fixer_main() {
  local working_directory="$1"
  if [[ -n "${GROOVY_JAR:-}" ]]; then
    (cd "${working_directory}" && java -cp "${compiled_classes}:${GROOVY_JAR}" FixPackagePaths)
  else
    (cd "${working_directory}" && groovy -cp "${compiled_classes}" -e 'FixPackagePaths.main(new String[0])')
  fi
}

compile_fixer
javap -classpath "${compiled_classes}" FixPackagePaths | grep -Fq 'public static void main(java.lang.String...);'

mkdir -p "${fixture_root}/groovy-test/com/example/nested"
mkdir -p "${fixture_root}/groovy-test/defaults"
mkdir -p "${fixture_root}/groovy-test/unchanged"

printf '%s\n' 'package wrong.name // keep this note' '' 'class RootCase {}' >"${fixture_root}/groovy-test/RootCase.groovy"
printf '%s\n' 'package wrong.name' '' 'class GroovyCase {}' >"${fixture_root}/groovy-test/com/example/GroovyCase.groovy"
printf '%s\n' '/* license */' '' 'package wrong.name;' '' 'class JavaCase {}' >"${fixture_root}/groovy-test/com/example/nested/JavaCase.java"
printf '%s\n' '// header' 'class MissingPackageCase {}' >"${fixture_root}/groovy-test/defaults/MissingPackageCase.groovy"
printf '%s\n' 'package unchanged' '' 'class UnchangedCase {}' >"${fixture_root}/groovy-test/unchanged/UnchangedCase.groovy"

run_output="$(run_fixer_main "${fixture_root}")"
grep -Fq '4 package declaration(s) corrected.' <<<"${run_output}"
grep -Fqx '// keep this note' "${fixture_root}/groovy-test/RootCase.groovy"
if grep -Eq '^[[:space:]]*package[[:space:]]' "${fixture_root}/groovy-test/RootCase.groovy"; then
  echo 'Expected a root source to use the default package.' >&2
  exit 1
fi
grep -Fqx 'package com.example' "${fixture_root}/groovy-test/com/example/GroovyCase.groovy"
grep -Fqx 'package com.example.nested;' "${fixture_root}/groovy-test/com/example/nested/JavaCase.java"
grep -Fqx 'package defaults' "${fixture_root}/groovy-test/defaults/MissingPackageCase.groovy"
grep -Fqx 'package unchanged' "${fixture_root}/groovy-test/unchanged/UnchangedCase.groovy"

idempotent_output="$(run_fixer_main "${fixture_root}")"
grep -Fq '0 package declaration(s) corrected.' <<<"${idempotent_output}"

invalid_root="${fixture_root}/invalid-workspace"
mkdir -p "${invalid_root}/groovy-test/valid" "${invalid_root}/groovy-test/not-valid"
printf '%s\n' 'package old' 'class ValidCase {}' >"${invalid_root}/groovy-test/valid/ValidCase.groovy"
printf '%s\n' 'package old' 'class InvalidCase {}' >"${invalid_root}/groovy-test/not-valid/InvalidCase.groovy"
valid_before="$(sha256sum "${invalid_root}/groovy-test/valid/ValidCase.groovy")"
if run_fixer_main "${invalid_root}" >/dev/null 2>&1; then
  echo 'Expected an invalid directory name to fail validation.' >&2
  exit 1
fi
valid_after="$(sha256sum "${invalid_root}/groovy-test/valid/ValidCase.groovy")"
[[ "${valid_before}" == "${valid_after}" ]]

echo 'fix-package-paths tests passed'
