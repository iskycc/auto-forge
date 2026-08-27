#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_path="${repository_root}/groovy-test/AnalyzeNormalGroovyCases.java"

fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT
source_root="${fixture_root}/cases"
output_file="${fixture_root}/normal-cases.xlsx"
compiled_classes="${fixture_root}/classes"
scope_workspace="${fixture_root}/scope-workspace"
scope_output_file="${scope_workspace}/scope.xlsx"
mkdir -p "${source_root}/account" "${source_root}/orders"
mkdir -p "${compiled_classes}"
mkdir -p "${scope_workspace}/groovy-test" "${scope_workspace}/unrelated"

normalize_classpath() {
  local raw_classpath="$1"
  local -a entries=()
  local -a absolute_entries=()
  IFS=':' read -r -a entries <<<"${raw_classpath}"
  for entry in "${entries[@]}"; do
    absolute_entries+=("$(realpath "${entry}")")
  done
  local IFS=':'
  printf '%s' "${absolute_entries[*]}"
}

if [[ -z "${POI_CLASSPATH:-}" ]]; then
  echo 'Set POI_CLASSPATH to Apache POI 3.13 and its transitive dependencies.' >&2
  exit 1
fi
POI_CLASSPATH="$(normalize_classpath "${POI_CLASSPATH}")"

printf '%s\n' \
  'package sample.account' \
  'import sample.fixture.LoginSupport' \
  'class LoginSpec {' \
  '    @Test(description = "用户可以正常登录")' \
  '    void testSuccessfulLogin() { assert true }' \
  '' \
  '    @Test(description = "Balance state")' \
  '    void testInsufficientBalance() { assert true }' \
  '' \
  '    @Test(description = "Account state")' \
  '    void testClosedAccount() { assert true }' \
  '' \
  '    @Test(description = "Card state")' \
  '    void testFrozenCard() { assert true }' \
  '' \
  '    @Test(description = "Customer state")' \
  '    void testDormantCustomer() { assert true }' \
  '' \
  '    @Test(description = "Status transition")' \
  '    void testStatusNewWorkflow() { assert true }' \
  '' \
  '    @Test(description = "Pending activation")' \
  '    void testStatusPendingActiveWorkflow() { assert true }' \
  '' \
  '    @Test(description = "Invalid password returns an Error")' \
  '    void testInvalidPassword() {' \
  '        shouldFail(IllegalArgumentException) { throw new IllegalArgumentException("bad") }' \
  '    }' \
  '}' \
  '' \
  'class NormalSignalsSpec {' \
  '    @Test(description = "Completes without Error")' \
  '    void testCompletesWithoutError() { assert true }' \
  '' \
  '    @Test(description = "Ordinary reporting mentions a count")' \
  '    void testReportSummary() { println "Error count is zero" }' \
  '' \
  '    @Test(description = "Business guard")' \
  '    void testBusinessGuard() { throw new IllegalStateException("guard") }' \
  '' \
  '    @Test(description = "Catch guard")' \
  '    void testCatchGuard() {' \
  '        try { assert true } catch (IllegalStateException error) { assert false }' \
  '    }' \
  '' \
  '    @Test(description = "Similar but distinct status")' \
  '    void testStatusNewerWorkflow() { assert true }' \
  '' \
  '    @Test(description = "Completes without StatusNew")' \
  '    void testCompletesWithoutStatusNew() { assert true }' \
  '}' \
  '' \
  '@Test(description = "User-visible alias")' \
  'class FrozenCommentCase {' \
  '    @Test(description = "Contains frozen narrative")' \
  '    void testNormal() { println "frozen account" }' \
  '}' >"${source_root}/account/LoginSpec.groovy"

printf '%s\n' \
  '@Grab("missing.fixture:must-not-be-resolved:1.0")' \
  'package sample.orders; // optional trailing punctuation' \
  'import sample.fixture.CheckoutSupport' \
  'class CheckoutCase {' \
  '    void testHappyPath() {' \
  '        def type = String.class' \
  '        context { assert "success" }' \
  '    }' \
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

printf '%s\n' \
  'class IncludedCase {' \
  '    void testIncluded() { assert true }' \
  '}' >"${scope_workspace}/groovy-test/IncludedCase.groovy"

printf '%s\n' \
  'class OutsideSuspendedCase {' \
  '    void testOutsideSuspended() { assert true }' \
  '}' >"${scope_workspace}/unrelated/OutsideSuspendedCase.groovy"

run_analyzer() {
  javac -source 1.8 -target 1.8 -Xlint:-options -encoding UTF-8 -cp "${POI_CLASSPATH}" \
    -d "${compiled_classes}" "${source_path}"
  java -cp "${compiled_classes}:${POI_CLASSPATH}" AnalyzeNormalGroovyCases \
    --source "${source_root}" --output "${output_file}" \
    --extra-keywords statusnew,statuspendingactive --no-review
}

run_output="$(run_analyzer)"
scope_run_output="$({
  cd "${scope_workspace}"
  java -cp "${compiled_classes}:${POI_CLASSPATH}" AnalyzeNormalGroovyCases \
    --output "${scope_output_file}" --no-review
})"
grep -Fq 'Scanned 5 Groovy file(s) and 7 case candidate(s).' <<<"${run_output}"
grep -Fq 'Exported 2 included case(s); 5 candidate(s) were excluded.' <<<"${run_output}"
grep -Fq "1 file(s) had scan issues; see the '扫描问题' worksheet." <<<"${run_output}"
grep -Fq "Source root: ${scope_workspace}/groovy-test" <<<"${scope_run_output}"
grep -Fq 'Scanned 1 Groovy file(s) and 1 case candidate(s).' <<<"${scope_run_output}"
unzip -t "${output_file}" >/dev/null
unzip -t "${scope_output_file}" >/dev/null

first_review_output="$(printf '0' | java \
  -cp "${compiled_classes}:${POI_CLASSPATH}" AnalyzeNormalGroovyCases \
  --source "${source_root}" --output "${output_file}")"
grep -Fq 'Workbook exists; skipping scan and resuming case-level review.' \
  <<<"${first_review_output}"
grep -Fq '人工分级已暂停，剩余 1 条未确认；下次运行将自动继续。' \
  <<<"${first_review_output}"

resumed_review_output="$(printf '910' | java \
  -cp "${compiled_classes}:${POI_CLASSPATH}" AnalyzeNormalGroovyCases \
  --source "${source_root}" --output "${output_file}")"
grep -Fq '[2/2]' <<<"${resumed_review_output}"
grep -Fq '[1/2]' <<<"${resumed_review_output}"
grep -Fq '人工分级已完成，所有导出用例均已标记。' <<<"${resumed_review_output}"

node --input-type=module - \
  "${repository_root}" "${output_file}" "${scope_output_file}" <<'NODE'
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const repositoryRoot = process.argv[2];
const outputFile = process.argv[3];
const scopeOutputFile = process.argv[4];
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

const normalCases = xlsxModule.utils.sheet_to_json(workbook.Sheets["导出用例"]);
const excludedCases = xlsxModule.utils.sheet_to_json(workbook.Sheets["排除明细"]);
const issues = xlsxModule.utils.sheet_to_json(workbook.Sheets["扫描问题"]);

if (normalCases.length !== 2 || excludedCases.length !== 5 || issues.length !== 1) {
  throw new Error("Unexpected workbook row counts");
}
const formerReviewCase = excludedCases.find(
  (row) => row["类名"] === "NormalSignalsSpec",
);
if (!String(formerReviewCase?.["排除证据"]).includes("注释或字符串命中：error")) {
  throw new Error("A comment/string keyword signal was not promoted to exclusion evidence");
}
if (!String(formerReviewCase?.["排除证据"]).includes("代码主动抛出异常")) {
  throw new Error("A throw signal was not promoted to exclusion evidence");
}
if (!String(formerReviewCase?.["排除证据"]).includes("代码捕获异常")) {
  throw new Error("A catch signal was not promoted to exclusion evidence");
}
if (normalCases.some((row) => row["复核提示"] !== undefined)) {
  throw new Error("The obsolete review hint column is still exported");
}
if (!normalCases.some((row) => row["类名"] === "ScriptSmoke")) {
  throw new Error("Normal Groovy script was not exported");
}
if ([...normalCases, ...excludedCases].some((row) => row["类名"] === "context")) {
  throw new Error("A .class literal caused the following context block to be parsed as a class");
}
const reviewedLevels = normalCases.map((row) => row["人工等级"]);
if (reviewedLevels.join(",") !== "L1,L0") {
  throw new Error(`Interactive review did not persist/resume correctly: ${reviewedLevels}`);
}
const loginCases = [...normalCases, ...excludedCases].filter(
  (row) => row["类名"] === "LoginSpec",
);
if (loginCases.length !== 1 || loginCases[0]["测试方法"] !== undefined) {
  throw new Error("Multiple methods in one class were exported as separate cases");
}
if (!String(loginCases[0]["命中关键词"]).includes("statusnew")) {
  throw new Error("A compact keyword did not match a CamelCase method in its class");
}
if (!String(loginCases[0]["命中关键词"]).includes("statuspendingactive")) {
  throw new Error("A multi-word compact keyword did not match a CamelCase method in its class");
}
if (!excludedCases.some((row) => row["类名"] === "SuspendedAccountCase")) {
  throw new Error("Negative class name was not excluded");
}
const frozenCommentCase = excludedCases.find(
  (row) => row["类名"] === "FrozenCommentCase",
);
if (frozenCommentCase?.["用例标题"] !== "FrozenCommentCase") {
  throw new Error("The class name after the class keyword was not used as the case title");
}
if (frozenCommentCase?.["排除证据"] !== "标题（class 后的类名）明确命中：frozen") {
  throw new Error("A title keyword was still reported as a comment/string-only signal");
}
if (loginCases.some((row) => row["包名"] !== "sample.account")) {
  throw new Error("Package parsing crossed the declaration line into an import");
}
if (formerReviewCase?.["包名"] !== "sample.account") {
  throw new Error("Package parsing was not applied to every class in a source file");
}
const checkoutCase = normalCases.find((row) => row["类名"] === "CheckoutCase");
if (checkoutCase?.["包名"] !== "sample.orders") {
  throw new Error("Trailing package punctuation was not removed");
}
if (!issues.some((row) => row["相对路径"] === "BrokenCase.groovy")) {
  throw new Error("A malformed Groovy source was not reported");
}
const brokenCase = excludedCases.find((row) => row["类名"] === "BrokenCase");
if (!String(brokenCase?.["排除证据"]).includes("无法可靠解析，已排除")) {
  throw new Error("An unparseable source was not excluded");
}
if (!issues.some((row) => row["处理结果"] === "已排除")) {
  throw new Error("A scan issue did not record its exclusion result");
}

const scopeWorkbook = xlsxModule.read(readFileSync(scopeOutputFile));
const scopedCases = xlsxModule.utils.sheet_to_json(scopeWorkbook.Sheets["导出用例"]);
const scopedExcludedCases = xlsxModule.utils.sheet_to_json(
  scopeWorkbook.Sheets["排除明细"],
);
if (
  scopedCases.length !== 1 ||
  scopedCases[0]?.["类名"] !== "IncludedCase" ||
  scopedExcludedCases.length !== 0
) {
  throw new Error("Default scanning escaped the groovy-test directory boundary");
}
NODE

echo 'analyze-normal-groovy-cases tests passed'
