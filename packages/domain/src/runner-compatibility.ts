import type { Runner } from "./runner";

export const CURRENT_RUNNER_PROTOCOL_VERSION = 1;
export const MINIMUM_JAVA_MAJOR_VERSION = 11;
export const SUPPORTED_TESTNG_VERSION = "7.11.0";
export const COTEST_ADAPTER_CAPABILITY = "adapter:cotest-testng-v1";
export const PROJECT_RUNTIME_ASSETS_CAPABILITY = "runtime:project-assets-v1";
export const REQUIRED_EXECUTION_CAPABILITIES = [
  "executor:testng-v1",
  `testng:${SUPPORTED_TESTNG_VERSION}`,
] as const;
export const REQUIRED_EXECUTION_LABELS = ["java", "testng"] as const;
export const DEFAULT_EXECUTION_RESOURCE_LIMITS = {
  cpuMillicores: 2_000,
  memoryBytes: 2_147_483_648,
  diskBytes: 10_737_418_240,
  processCount: 256,
  fileCount: 10_000,
  logBytes: 1_073_741_824,
  artifactBytes: 10_737_418_240,
} as const;

export type RunnerCompatibilityIssue =
  | "protocol_unsupported"
  | "platform_unsupported"
  | "testng_executor_missing"
  | "resource_isolation_missing"
  | "java_version_unknown"
  | "java_version_unsupported"
  | "testng_version_unknown"
  | "testng_version_unsupported"
  | "agent_version_unversioned";

export type RunnerCompatibility = {
  compatible: boolean;
  status: "compatible" | "attention" | "incompatible";
  issues: RunnerCompatibilityIssue[];
  javaVersion?: string;
  testNgVersion?: string;
};

const supportedPlatforms = new Set(["linux/amd64", "linux/arm64"]);
const semanticVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function assessRunnerCompatibility(
  runner: Pick<Runner, "agentVersion" | "architecture" | "capabilities" | "os" | "protocolVersion">,
): RunnerCompatibility {
  const capabilities = new Set(runner.capabilities);
  const acceptsProjectRuntime =
    capabilities.has(COTEST_ADAPTER_CAPABILITY) &&
    capabilities.has(PROJECT_RUNTIME_ASSETS_CAPABILITY);
  const issues: RunnerCompatibilityIssue[] = [];
  if (runner.protocolVersion !== CURRENT_RUNNER_PROTOCOL_VERSION) {
    issues.push("protocol_unsupported");
  }
  if (!supportedPlatforms.has(`${runner.os.toLowerCase()}/${runner.architecture.toLowerCase()}`)) {
    issues.push("platform_unsupported");
  }
  if (!capabilities.has("executor:testng-v1")) {
    issues.push("testng_executor_missing");
  }
  if (!capabilities.has("isolation:cgroup-v2")) {
    issues.push("resource_isolation_missing");
  }
  const javaVersion = capabilityVersion(runner.capabilities, "java:");
  // 项目运行时能力会为每次 assignment 下发权威 JDK 与依赖；Agent 主机上偶然
  // 探测到的 Java/TestNG 只用于诊断，不能阻断调度。
  if (!acceptsProjectRuntime) {
    if (!javaVersion) issues.push("java_version_unknown");
    else if ((javaMajorVersion(javaVersion) ?? 0) < MINIMUM_JAVA_MAJOR_VERSION) {
      issues.push("java_version_unsupported");
    }
  }
  const testNgVersion = capabilityVersion(runner.capabilities, "testng:");
  if (!acceptsProjectRuntime) {
    if (!testNgVersion) issues.push("testng_version_unknown");
    else if (testNgVersion !== SUPPORTED_TESTNG_VERSION) {
      issues.push("testng_version_unsupported");
    }
  }
  if (!semanticVersionPattern.test(runner.agentVersion)) {
    issues.push("agent_version_unversioned");
  }
  const blockingIssues = new Set<RunnerCompatibilityIssue>([
    "protocol_unsupported",
    "platform_unsupported",
    "testng_executor_missing",
    "java_version_unknown",
    "java_version_unsupported",
    "testng_version_unknown",
    "testng_version_unsupported",
  ]);
  const compatible = !issues.some((issue) => blockingIssues.has(issue));
  return {
    compatible,
    status: compatible ? (issues.length === 0 ? "compatible" : "attention") : "incompatible",
    issues,
    ...(javaVersion ? { javaVersion } : {}),
    ...(testNgVersion ? { testNgVersion } : {}),
  };
}

export function isAgentUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  const current = parseAgentVersion(currentVersion);
  const latest = parseAgentVersion(latestVersion);
  if (!current || !latest) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current.numbers[index] !== latest.numbers[index]) {
      return current.numbers[index]! < latest.numbers[index]!;
    }
  }
  // 数字部分相同时，带预发布段的版本早于正式版（semver 第 11 条）。
  return current.prerelease !== undefined && latest.prerelease === undefined;
}

function parseAgentVersion(
  version: string,
): { numbers: [number, number, number]; prerelease?: string } | undefined {
  if (!semanticVersionPattern.test(version)) return undefined;
  const [core, prerelease] = version.split("-", 2);
  const numbers = core!.split(".").map(Number) as [number, number, number];
  return prerelease === undefined ? { numbers } : { numbers, prerelease };
}

function javaMajorVersion(version: string): number | undefined {
  const parts = version.match(/\d+/g)?.map(Number);
  if (!parts || parts.length === 0) return undefined;
  return parts[0] === 1 && parts.length > 1 ? parts[1] : parts[0];
}

function capabilityVersion(capabilities: readonly string[], prefix: string): string | undefined {
  return capabilities
    .filter((capability) => capability.startsWith(prefix) && capability.length > prefix.length)
    .map((capability) => capability.slice(prefix.length))
    .sort()[0];
}
