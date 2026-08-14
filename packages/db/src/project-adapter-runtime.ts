import {
  COTEST_ADAPTER_CAPABILITY,
  PROJECT_RUNTIME_ASSETS_CAPABILITY,
  REQUIRED_EXECUTION_CAPABILITIES,
} from "@autoforge/domain";

const maximumRuntimeAssetBytes = 10_737_418_240;
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
  environmentAddress: string;
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
    return {
      suiteName: boundedString(record.suiteName, 512),
      testName: boundedString(record.testName, 512),
      environmentAddress: boundedString(record.environmentAddress, 2_048),
      ...(jdk ? { jdk } : {}),
      ...(jarBundle ? { jarBundle } : {}),
    };
  } catch (cause) {
    throw new Error("Stored project Adapter runtime snapshot is invalid.", { cause });
  }
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

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError("Stored enum value is invalid.");
  }
  return value;
}
