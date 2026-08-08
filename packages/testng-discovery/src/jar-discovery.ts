import { createHash } from "node:crypto";

import type { JarDiscoveryPort } from "@autoforge/application";
import {
  jarInspectionSchema,
  type JarInspection,
  type JarInspectionWarning,
} from "@autoforge/contracts";
import { unzipSync } from "fflate";

import { parseTestNgClassFile } from "./class-file";

const DEFAULT_MAX_JAR_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_CLASS_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TEST_CLASSES = 5_000;
const MAX_WARNINGS = 100;

export class JarInspectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JarInspectionError";
    this.code = code;
  }
}

export type TestNgJarDiscoveryOptions = {
  maxJarBytes?: number;
  maxUncompressedBytes?: number;
  maxEntries?: number;
  maxClassBytes?: number;
  maxTestClasses?: number;
};

function safeFileName(fileName: string): string {
  const normalized = fileName.split(/[\\/]/).at(-1)?.trim() ?? "";
  if (!normalized || normalized.length > 255 || normalized.includes("\0")) {
    throw new JarInspectionError("INVALID_FILE_NAME", "JAR 文件名无效。");
  }
  if (!normalized.toLowerCase().endsWith(".jar")) {
    throw new JarInspectionError("INVALID_FILE_TYPE", "仅支持 .jar 文件。");
  }
  return normalized;
}

function pushWarning(warnings: JarInspectionWarning[], warning: JarInspectionWarning): void {
  if (warnings.length < MAX_WARNINGS) {
    warnings.push(warning);
  }
}

export class TestNgJarDiscovery implements JarDiscoveryPort {
  private readonly maxJarBytes: number;
  private readonly maxUncompressedBytes: number;
  private readonly maxEntries: number;
  private readonly maxClassBytes: number;
  private readonly maxTestClasses: number;

  constructor(options: TestNgJarDiscoveryOptions = {}) {
    this.maxJarBytes = options.maxJarBytes ?? DEFAULT_MAX_JAR_BYTES;
    this.maxUncompressedBytes = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxClassBytes = options.maxClassBytes ?? DEFAULT_MAX_CLASS_BYTES;
    this.maxTestClasses = options.maxTestClasses ?? DEFAULT_MAX_TEST_CLASSES;
  }

  async inspect(fileName: string, content: Uint8Array): Promise<JarInspection> {
    const normalizedFileName = safeFileName(fileName);
    if (content.byteLength === 0) {
      throw new JarInspectionError("EMPTY_JAR", "JAR 文件为空。");
    }
    if (content.byteLength > this.maxJarBytes) {
      throw new JarInspectionError(
        "JAR_TOO_LARGE",
        `JAR 超过 ${this.maxJarBytes} 字节的导入限制。`,
      );
    }
    if (content[0] !== 0x50 || content[1] !== 0x4b) {
      throw new JarInspectionError("INVALID_JAR", "文件不是有效的 ZIP/JAR 格式。");
    }

    let entryCount = 0;
    let totalUncompressedBytes = 0;
    let hasVersionedClasses = false;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(content, {
        filter: (entry) => {
          entryCount += 1;
          totalUncompressedBytes += entry.originalSize;
          if (entryCount > this.maxEntries) {
            throw new JarInspectionError(
              "TOO_MANY_ENTRIES",
              `JAR 条目数超过 ${this.maxEntries} 的限制。`,
            );
          }
          if (totalUncompressedBytes > this.maxUncompressedBytes) {
            throw new JarInspectionError(
              "JAR_EXPANDS_TOO_LARGE",
              `JAR 解压后超过 ${this.maxUncompressedBytes} 字节的限制。`,
            );
          }
          if (entry.name.startsWith("META-INF/versions/") && entry.name.endsWith(".class")) {
            hasVersionedClasses = true;
            return false;
          }
          return entry.name === "testng.xml" || entry.name.endsWith(".class");
        },
      });
    } catch (error) {
      if (error instanceof JarInspectionError) {
        throw error;
      }
      throw new JarInspectionError("INVALID_JAR", "JAR 解压失败或目录结构无效。", {
        cause: error,
      });
    }

    const warnings: JarInspectionWarning[] = [];
    if (hasVersionedClasses) {
      pushWarning(warnings, {
        code: "MULTI_RELEASE_IGNORED",
        message: "首版扫描忽略 META-INF/versions 下的多版本 class 条目。",
      });
    }

    const classEntries = Object.entries(entries)
      .filter(([name]) => name.endsWith(".class"))
      .sort(([left], [right]) => left.localeCompare(right));
    const discovered = new Map<string, ReturnType<typeof parseTestNgClassFile>>();

    for (const [entryName, bytes] of classEntries) {
      if (bytes.byteLength > this.maxClassBytes) {
        pushWarning(warnings, {
          code: "CLASS_TOO_LARGE",
          message: `class 条目超过 ${this.maxClassBytes} 字节，已跳过。`,
          entry: entryName,
        });
        continue;
      }
      try {
        const parsed = parseTestNgClassFile(bytes);
        if (parsed) {
          if (!discovered.has(parsed.className) && discovered.size >= this.maxTestClasses) {
            throw new JarInspectionError(
              "TOO_MANY_TEST_CLASSES",
              `发现的 TestNG 测试类超过 ${this.maxTestClasses} 个。`,
            );
          }
          discovered.set(parsed.className, parsed);
        }
      } catch (error) {
        if (error instanceof JarInspectionError) {
          throw error;
        }
        pushWarning(warnings, {
          code: "CLASS_PARSE_FAILED",
          message: error instanceof Error ? error.message : "class 解析失败。",
          entry: entryName,
        });
      }
    }

    const classes = [...discovered.values()]
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((left, right) => left.className.localeCompare(right.className));
    const testMethodCount = classes.reduce((sum, candidate) => sum + candidate.methods.length, 0);

    if (classEntries.length === 0) {
      pushWarning(warnings, {
        code: "NO_CLASS_FILES",
        message: "JAR 中没有发现 .class 文件。",
      });
    } else if (classes.length === 0) {
      pushWarning(warnings, {
        code: "NO_TESTNG_ANNOTATIONS",
        message: "没有发现 TestNG @Test 类或方法；首版不会加载字节码推断动态测试。",
      });
    }
    if (warnings.length === MAX_WARNINGS) {
      warnings.push({
        code: "WARNINGS_TRUNCATED",
        message: `只保留前 ${MAX_WARNINGS} 条扫描警告。`,
      });
    }

    return jarInspectionSchema.parse({
      schemaVersion: 1,
      fileName: normalizedFileName,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
      classFileCount: classEntries.length,
      testClassCount: classes.length,
      testMethodCount,
      hasRootTestNgXml: Object.hasOwn(entries, "testng.xml"),
      discoveryMode: "bytecode-annotations",
      classes,
      warnings,
    });
  }
}
