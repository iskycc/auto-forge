import type { RunnerCompatibility, RunnerCompatibilityIssue } from "@autoforge/domain";

const issueLabels: Record<RunnerCompatibilityIssue, string> = {
  protocol_unsupported: "协议版本不受支持",
  platform_unsupported: "操作系统或架构不受支持",
  testng_executor_missing: "缺少 TestNG 执行能力",
  resource_isolation_missing: "缺少 cgroup v2 资源隔离",
  java_version_unknown: "未上报 Java 版本",
  java_version_unsupported: "Java 版本低于执行基线",
  testng_version_unknown: "未上报 TestNG 版本",
  testng_version_unsupported: "TestNG 版本与执行基线不一致",
  agent_version_unversioned: "Agent 不是正式版本",
};

export function runnerCompatibilityLabel(status: RunnerCompatibility["status"]): string {
  if (status === "compatible") return "兼容";
  if (status === "attention") return "需关注";
  return "不兼容";
}

export function runnerCompatibilitySummary(compatibility: RunnerCompatibility): string {
  return compatibility.issues.map((issue) => issueLabels[issue]).join("；") || "协议与执行能力就绪";
}

export function runnerToolchainSummary(compatibility: RunnerCompatibility): string {
  return `Java ${compatibility.javaVersion ?? "未知"} · TestNG ${compatibility.testNgVersion ?? "未知"}`;
}
