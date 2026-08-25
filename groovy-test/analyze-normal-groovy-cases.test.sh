#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_path="${repository_root}/groovy-test/AnalyzeNormalGroovyCases.groovy"

fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT
source_root="${fixture_root}/cases"
output_file="${fixture_root}/normal-cases.xlsx"
mkdir -p "${source_root}/account" "${source_root}/orders"

printf '%s\n' \
  'package sample.account' \
  'class LoginSpec {' \
  '    @Test(description = "用户可以正常登录")' \
  '    void testSuccessfulLogin() { assert true }' \
  '' \
  '    @Test(description = "Completes without Error")' \
  '    void testCompletesWithoutError() { assert true }' \
  '' \
  '    @Test(description = "Invalid password returns an Error")' \
  '    void testInvalidPassword() {' \
  '        shouldFail(IllegalArgumentException) { throw new IllegalArgumentException("bad") }' \
  '    }' \
  '}' >"${source_root}/account/LoginSpec.groovy"

printf '%s\n' \
  'package sample.orders' \
  'class CheckoutCase {' \
  '    void testHappyPath() { assert "success" }' \
  '}' >"${source_root}/orders/CheckoutCase.groovy"

printf '%s\n' \
  'class SuspendedAccountCase {' \
  '    void testSuspendedAccount() { assert true }' \
  '}' >"${source_root}/account/SuspendedAccountCase.groovy"

printf '%s\n' \
  'println "正常的脚本场景"' >"${source_root}/ScriptSmoke.groovy"

printf '%s\n' \
  'class BrokenCase {' \
  '    void testIncomplete(' >"${source_root}/BrokenCase.groovy"

run_analyzer() {
  if command -v groovy >/dev/null 2>&1; then
    groovy "${script_path}" --source "${source_root}" --output "${output_file}"
    return
  fi
  if [[ -z "${GROOVY_JAR:-}" || -z "${IVY_JAR:-}" ]]; then
    echo 'Install Groovy or set GROOVY_JAR and IVY_JAR to run this test.' >&2
    return 1
  fi
  java -cp "${GROOVY_JAR}:${IVY_JAR}" groovy.ui.GroovyMain \
    "${script_path}" --source "${source_root}" --output "${output_file}"
}

run_output="$(run_analyzer)"
grep -Fq 'Scanned 5 Groovy file(s) and 6 case candidate(s).' <<<"${run_output}"
grep -Fq 'Exported 4 normal case(s); 2 candidate(s) were excluded.' <<<"${run_output}"
grep -Fq "1 file(s) could not be analyzed; see the '扫描问题' worksheet." <<<"${run_output}"
unzip -t "${output_file}" >/dev/null

node --input-type=module - "${repository_root}" "${output_file}" <<'NODE'
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const repositoryRoot = process.argv[2];
const outputFile = process.argv[3];
const xlsxModule = await import(
  pathToFileURL(`${repositoryRoot}/packages/ddt-import/node_modules/xlsx/xlsx.mjs`).href
);
const originalConsoleError = console.error;
console.error = () => {};
let workbook;
try {
  workbook = xlsxModule.read(readFileSync(outputFile));
} finally {
  console.error = originalConsoleError;
}

const normalCases = xlsxModule.utils.sheet_to_json(workbook.Sheets["正常用例"]);
const excludedCases = xlsxModule.utils.sheet_to_json(workbook.Sheets["排除明细"]);
const issues = xlsxModule.utils.sheet_to_json(workbook.Sheets["扫描问题"]);

if (normalCases.length !== 4 || excludedCases.length !== 2 || issues.length !== 1) {
  throw new Error("Unexpected workbook row counts");
}
if (!normalCases.some((row) => row["测试方法"] === "testSuccessfulLogin")) {
  throw new Error("Normal annotated test method was not exported");
}
if (!normalCases.some((row) => row["测试方法"] === "testCompletesWithoutError")) {
  throw new Error("A negated error phrase was incorrectly classified as abnormal");
}
if (!normalCases.some((row) => row["类名"] === "ScriptSmoke")) {
  throw new Error("Normal Groovy script was not exported");
}
if (!excludedCases.some((row) => row["测试方法"] === "testInvalidPassword")) {
  throw new Error("Negative method in a mixed class was not excluded independently");
}
if (!excludedCases.some((row) => row["类名"] === "SuspendedAccountCase")) {
  throw new Error("Negative class name was not excluded");
}
if (!issues.some((row) => row["相对路径"] === "BrokenCase.groovy")) {
  throw new Error("A malformed Groovy source was not reported");
}
NODE

echo 'analyze-normal-groovy-cases tests passed'
