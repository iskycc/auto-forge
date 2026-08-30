import {
  COTEST_ADAPTER_CAPABILITY,
  DEFAULT_EXECUTION_RESOURCE_LIMITS,
  PROJECT_RUNTIME_ASSETS_CAPABILITY,
  REQUIRED_EXECUTION_CAPABILITIES,
} from "@autoforge/domain";

const maximumRuntimeAssetBytes = Number.MAX_SAFE_INTEGER;
const maximumExecutionDiskBytes = 10_995_116_277_760;
const adapterArchiveExpansionFactor = 8;
const adapterArchiveFileLimit = 100_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export type RuntimeAssetSnapshot = {
  id: string;
  sourceType: "upload" | "url";
  url?: string;
  sha256: string;
  sizeBytes: number;
  archiveFormat: "zip" | "tar.gz";
};

export type ProjectAdapterRuntime = {
  suiteName: string;
  testName: string;
  // 完整环境池必须随批次快照持久化；只保存 run -> address 会在用例数少于
  // 环境数时丢失未被首轮选中的地址，导致后续 attempt 无法轮换环境。
  environmentAddresses: string[];
  environmentAddressByRunId: Record<string, string>;
  fallbackEnvironmentAddress: string;
  jdk?: RuntimeAssetSnapshot;
  jarBundle?: RuntimeAssetSnapshot;
};

export function parseProjectAdapterRuntime(
  snapshot: string | null,
): ProjectAdapterRuntime | undefined {
  if (!snapshot) return undefined;
  try {
    const record = objectRecord(JSON.parse(snapshot));
    const jdk = optionalRuntimeAsset(record.jdk);
    const jarBundle = optionalRuntimeAsset(record.jarBundle);
    const environmentAddressByRunId = stringRecord(record.environmentAddressByRunId);
    const fallbackEnvironmentAddress =
      record.fallbackEnvironmentAddress === undefined
        ? boundedString(record.environmentAddress ?? "", 2_048)
        : boundedString(record.fallbackEnvironmentAddress, 2_048);
    return {
      suiteName: boundedString(record.suiteName, 512),
      testName: boundedString(record.testName, 512),
      environmentAddresses:
        record.environmentAddresses === undefined
          ? uniqueStrings([
              ...Object.values(environmentAddressByRunId),
              ...(fallbackEnvironmentAddress ? [fallbackEnvironmentAddress] : []),
            ])
          : stringArray(record.environmentAddresses),
      environmentAddressByRunId,
      fallbackEnvironmentAddress,
      ...(jdk ? { jdk } : {}),
      ...(jarBundle ? { jarBundle } : {}),
    };
  } catch (cause) {
    throw new Error("Stored project Adapter runtime snapshot is invalid.", { cause });
  }
}

export function adapterEnvironmentAddress(
  runtime: ProjectAdapterRuntime,
  executionRunId: string,
  attemptNumber = 1,
): string {
  const initialAddress =
    runtime.environmentAddressByRunId[executionRunId] ?? runtime.fallbackEnvironmentAddress;
  if (runtime.environmentAddresses.length < 2) return initialAddress;
  const initialIndex = runtime.environmentAddresses.indexOf(initialAddress);
  if (initialIndex < 0) return initialAddress;
  const retryOffset = Math.max(0, Math.trunc(attemptNumber) - 1);
  return runtime.environmentAddresses[
    (initialIndex + retryOffset) % runtime.environmentAddresses.length
  ]!;
}

export function projectAdapterRequiredCapabilities(
  runtime: ProjectAdapterRuntime | undefined,
): string[] {
  if (!runtime) return [...REQUIRED_EXECUTION_CAPABILITIES];
  return runtime.jdk && runtime.jarBundle
    ? [COTEST_ADAPTER_CAPABILITY, PROJECT_RUNTIME_ASSETS_CAPABILITY]
    : [COTEST_ADAPTER_CAPABILITY, ...REQUIRED_EXECUTION_CAPABILITIES];
}

export function supportsProjectAdapterRuntime(
  capabilities: readonly string[],
  runtime: ProjectAdapterRuntime | undefined,
): boolean {
  const available = new Set(capabilities);
  return projectAdapterRequiredCapabilities(runtime).every((capability) =>
    available.has(capability),
  );
}

export function executionResourceLimitsForInputs(
  inputSizes: readonly number[],
  usesAdapter: boolean,
): { [Key in keyof typeof DEFAULT_EXECUTION_RESOURCE_LIMITS]: number } {
  if (!usesAdapter) return { ...DEFAULT_EXECUTION_RESOURCE_LIMITS };
  const totalInputBytes = inputSizes.reduce(safeByteSum, 0);
  if (totalInputBytes > maximumExecutionDiskBytes) {
    throw new TypeError("Execution inputs exceed the Runner Protocol disk limit.");
  }
  const expandedBudget = Math.min(
    maximumExecutionDiskBytes,
    totalInputBytes * adapterArchiveExpansionFactor,
  );
  return {
    ...DEFAULT_EXECUTION_RESOURCE_LIMITS,
    diskBytes: Math.max(DEFAULT_EXECUTION_RESOURCE_LIMITS.diskBytes, expandedBudget),
    fileCount: adapterArchiveFileLimit,
  };
}

function optionalRuntimeAsset(value: unknown): RuntimeAssetSnapshot | undefined {
  return value === undefined ? undefined : runtimeAsset(value);
}

function runtimeAsset(value: unknown): RuntimeAssetSnapshot {
  const record = objectRecord(value);
  const sourceType = enumValue(record.sourceType, ["upload", "url"] as const);
  const url = record.url === undefined ? undefined : boundedString(record.url, 2_048, 1);
  if (sourceType === "url") {
    if (!url) throw new TypeError("URL runtime asset is missing its URL.");
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new TypeError("Runtime asset URL must use HTTP or HTTPS.");
    }
  } else if (url !== undefined) {
    throw new TypeError("Uploaded runtime asset must not contain a URL.");
  }
  const sha256 = boundedString(record.sha256, 64, 64);
  if (!sha256Pattern.test(sha256)) throw new TypeError("Runtime asset SHA-256 is invalid.");
  const sizeBytes = record.sizeBytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > maximumRuntimeAssetBytes
  ) {
    throw new TypeError("Runtime asset size is invalid.");
  }
  return {
    id: boundedString(record.id, 128, 1),
    sourceType,
    ...(url ? { url } : {}),
    sha256,
    sizeBytes,
    archiveFormat: enumValue(record.archiveFormat, ["zip", "tar.gz"] as const),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximumLength: number, minimumLength = 0): string {
  if (typeof value !== "string" || value.length < minimumLength || value.length > maximumLength) {
    throw new TypeError("Stored string value is outside its allowed bounds.");
  }
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const record = objectRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      boundedString(key, 128, 1),
      boundedString(entry, 2_048, 1),
    ]),
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an array.");
  return uniqueStrings(value.map((entry) => boundedString(entry, 2_048, 1)));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError("Stored enum value is invalid.");
  }
  return value;
}

function safeByteSum(total: number, sizeBytes: number): number {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    total > Number.MAX_SAFE_INTEGER - sizeBytes
  ) {
    throw new TypeError("Execution input sizes exceed the protocol range.");
  }
  return total + sizeBytes;
}
