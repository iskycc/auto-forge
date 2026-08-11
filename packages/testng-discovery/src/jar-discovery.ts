import { createHash } from "node:crypto";

import type { JarDiscoveryPort } from "@autoforge/application";
import {
  jarInspectionSchema,
  type JarInspection,
  type JarInspectionWarning,
  type TestNgClassCandidate,
  type TestNgMethodCandidate,
  type TestNgXmlSelection,
} from "@autoforge/contracts";
import { unzipSync } from "fflate";

import { parseClassFile, type ParsedClassFile } from "./class-file";
import { parseTestNgXml, selectionIncludesClass } from "./testng-xml";

const DEFAULT_MAX_JAR_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_CLASS_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TEST_CLASSES = 5_000;
const DEFAULT_TARGET_JAVA_VERSION = 21;
const MAX_WARNINGS = 100;
const VERSIONED_CLASS_PATTERN = /^META-INF\/versions\/(\d+)\/(.+\.class)$/;

type SelectedClassEntry = {
  logicalName: string;
  entryName: string;
  bytes: Uint8Array;
  version: number;
};

type ParsedClassEntry = {
  entryName: string;
  bytes: Uint8Array;
  parsed: ParsedClassFile;
};

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
  targetJavaVersion?: number;
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
  if (warnings.length < MAX_WARNINGS) warnings.push(warning);
}

export class TestNgJarDiscovery implements JarDiscoveryPort {
  private readonly maxJarBytes: number;
  private readonly maxUncompressedBytes: number;
  private readonly maxEntries: number;
  private readonly maxClassBytes: number;
  private readonly maxTestClasses: number;
  private readonly targetJavaVersion: number;

  constructor(options: TestNgJarDiscoveryOptions = {}) {
    this.maxJarBytes = options.maxJarBytes ?? DEFAULT_MAX_JAR_BYTES;
    this.maxUncompressedBytes = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxClassBytes = options.maxClassBytes ?? DEFAULT_MAX_CLASS_BYTES;
    this.maxTestClasses = options.maxTestClasses ?? DEFAULT_MAX_TEST_CLASSES;
    this.targetJavaVersion = options.targetJavaVersion ?? DEFAULT_TARGET_JAVA_VERSION;
    if (!Number.isInteger(this.targetJavaVersion) || this.targetJavaVersion < 8) {
      throw new Error("targetJavaVersion 必须是不小于 8 的整数。");
    }
  }

  async inspect(fileName: string, content: Uint8Array): Promise<JarInspection> {
    const normalizedFileName = safeFileName(fileName);
    this.assertContentBoundary(content);
    const entries = this.extractRelevantEntries(content);
    const warnings: JarInspectionWarning[] = [];
    const classEntries = selectClassEntries(entries, this.targetJavaVersion, warnings);
    const parsedClasses = this.parseClasses(classEntries, warnings);
    let classes = resolveCandidates(parsedClasses, warnings);

    for (const parsed of parsedClasses.values()) {
      for (const semantic of parsed.parsed.dynamicSemantics) {
        pushWarning(warnings, dynamicSemanticWarning(semantic, parsed.entryName));
      }
    }

    const rootTestNgXml = entries["testng.xml"];
    const nestedTestNgXmlEntries = Object.keys(entries).filter(
      (name) => name.toLowerCase().endsWith("/testng.xml") && name !== "testng.xml",
    );
    if (nestedTestNgXmlEntries.length > 0) {
      pushWarning(warnings, {
        code: "TESTNG_XML_NESTED_IGNORED",
        message: `JAR 中 ${nestedTestNgXmlEntries.length} 个非根目录 testng.xml 未参与发现，仅解析根目录 testng.xml。`,
        entry: nestedTestNgXmlEntries[0],
      });
    }
    let selections: TestNgXmlSelection[] | undefined;
    if (rootTestNgXml) {
      try {
        const parsedXml = parseTestNgXml(rootTestNgXml);
        selections = parsedXml.selections;
        for (const warning of parsedXml.warnings) pushWarning(warnings, warning);
        classes = applyXmlSelections(classes, selections, warnings);
      } catch (error) {
        pushWarning(warnings, {
          code: "TESTNG_XML_INVALID",
          message: error instanceof Error ? error.message : "testng.xml 无法安全解析。",
          entry: "testng.xml",
        });
      }
    }

    if (classes.length > this.maxTestClasses) {
      throw new JarInspectionError(
        "TOO_MANY_TEST_CLASSES",
        `发现的 TestNG 测试类超过 ${this.maxTestClasses} 个。`,
      );
    }
    const testMethodCount = classes.reduce((sum, candidate) => sum + candidate.methods.length, 0);
    this.addEmptyDiscoveryWarnings(classEntries, classes, warnings);
    if (warnings.length === MAX_WARNINGS) {
      warnings.push({
        code: "WARNINGS_TRUNCATED",
        message: `只保留前 ${MAX_WARNINGS} 条扫描警告。`,
      });
    }

    const xmlParameters = selections ? mergeSelectionParameters(selections, warnings) : undefined;
    return jarInspectionSchema.parse({
      schemaVersion: 1,
      fileName: normalizedFileName,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
      classFileCount: classEntries.length,
      testClassCount: classes.length,
      testMethodCount,
      hasRootTestNgXml: Boolean(rootTestNgXml),
      ...(selections
        ? {
            testNgXml: {
              suiteName: selections[0]?.suiteName ?? "default-suite",
              testCount: selections.length,
              selectedClassCount: classes.length,
              parameters: xmlParameters ?? {},
            },
            testNgXmlSelections: selections,
          }
        : {}),
      targetJavaVersion: this.targetJavaVersion,
      discoveryMode: "bytecode-annotations",
      classes,
      warnings,
    });
  }

  private assertContentBoundary(content: Uint8Array): void {
    if (content.byteLength === 0) throw new JarInspectionError("EMPTY_JAR", "JAR 文件为空。");
    if (content.byteLength > this.maxJarBytes) {
      throw new JarInspectionError(
        "JAR_TOO_LARGE",
        `JAR 超过 ${this.maxJarBytes} 字节的导入限制。`,
      );
    }
    if (content[0] !== 0x50 || content[1] !== 0x4b) {
      throw new JarInspectionError("INVALID_JAR", "文件不是有效的 ZIP/JAR 格式。");
    }
  }

  private extractRelevantEntries(content: Uint8Array): Record<string, Uint8Array> {
    let entryCount = 0;
    let totalUncompressedBytes = 0;
    try {
      return unzipSync(content, {
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
          return (
            entry.name === "testng.xml" ||
            entry.name.toLowerCase().endsWith("/testng.xml") ||
            entry.name.toUpperCase() === "META-INF/MANIFEST.MF" ||
            entry.name.endsWith(".class")
          );
        },
      });
    } catch (error) {
      if (error instanceof JarInspectionError) throw error;
      throw new JarInspectionError("INVALID_JAR", "JAR 解压失败或目录结构无效。", {
        cause: error,
      });
    }
  }

  private parseClasses(
    classEntries: SelectedClassEntry[],
    warnings: JarInspectionWarning[],
  ): Map<string, ParsedClassEntry> {
    const parsed = new Map<string, ParsedClassEntry>();
    for (const entry of classEntries) {
      if (entry.bytes.byteLength > this.maxClassBytes) {
        pushWarning(warnings, {
          code: "CLASS_TOO_LARGE",
          message: `class 条目超过 ${this.maxClassBytes} 字节，已跳过。`,
          entry: entry.entryName,
        });
        continue;
      }
      try {
        const classFile = parseClassFile(entry.bytes);
        if (!classFile) continue;
        if (parsed.has(classFile.className)) {
          pushWarning(warnings, {
            code: "DUPLICATE_CLASS_NAME",
            message: "JAR 中包含重复类名；保留按多版本规则选择的首个条目。",
            entry: entry.entryName,
          });
          continue;
        }
        parsed.set(classFile.className, {
          entryName: entry.entryName,
          bytes: entry.bytes,
          parsed: classFile,
        });
      } catch (error) {
        pushWarning(warnings, {
          code: "CLASS_PARSE_FAILED",
          message: error instanceof Error ? error.message : "class 解析失败。",
          entry: entry.entryName,
        });
      }
    }
    return parsed;
  }

  private addEmptyDiscoveryWarnings(
    classEntries: SelectedClassEntry[],
    classes: TestNgClassCandidate[],
    warnings: JarInspectionWarning[],
  ): void {
    if (classEntries.length === 0) {
      pushWarning(warnings, { code: "NO_CLASS_FILES", message: "JAR 中没有发现 .class 文件。" });
    } else if (classes.length === 0) {
      pushWarning(warnings, {
        code: "NO_TESTNG_ANNOTATIONS",
        message: "没有发现 TestNG @Test 类或方法；静态扫描不会执行工厂或监听器扩展测试。",
      });
    }
  }
}

function selectClassEntries(
  entries: Record<string, Uint8Array>,
  targetJavaVersion: number,
  warnings: JarInspectionWarning[],
): SelectedClassEntry[] {
  const selected = new Map<string, SelectedClassEntry>();
  const manifest = Object.entries(entries).find(
    ([name]) => name.toUpperCase() === "META-INF/MANIFEST.MF",
  )?.[1];
  const multiReleaseEnabled = manifest ? manifestEnablesMultiRelease(manifest) : false;
  let sawVersioned = false;
  let ignoredFutureVersion = false;

  for (const [entryName, bytes] of Object.entries(entries).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!entryName.endsWith(".class")) continue;
    const versioned = VERSIONED_CLASS_PATTERN.exec(entryName);
    if (!versioned) {
      selected.set(entryName, { logicalName: entryName, entryName, bytes, version: 0 });
      continue;
    }
    sawVersioned = true;
    if (!multiReleaseEnabled) continue;
    const version = Number(versioned[1]);
    const logicalName = versioned[2];
    if (!logicalName || !Number.isInteger(version) || version < 9) {
      pushWarning(warnings, {
        code: "MULTI_RELEASE_ENTRY_INVALID",
        message: "多版本 class 条目的 Java 版本或路径无效，已跳过。",
        entry: entryName,
      });
      continue;
    }
    if (version > targetJavaVersion) {
      ignoredFutureVersion = true;
      continue;
    }
    const current = selected.get(logicalName);
    if (!current || current.version < version) {
      selected.set(logicalName, { logicalName, entryName, bytes, version });
    }
  }

  if (sawVersioned && !multiReleaseEnabled) {
    pushWarning(warnings, {
      code: "MULTI_RELEASE_NOT_ENABLED",
      message:
        "检测到版本化 class，但 Manifest 未声明 Multi-Release: true；按 JVM 语义仅扫描基础条目。",
    });
  }
  if (ignoredFutureVersion) {
    pushWarning(warnings, {
      code: "MULTI_RELEASE_TARGET_FILTERED",
      message: `已忽略高于目标 Java ${targetJavaVersion} 的多版本 class 条目。`,
    });
  }
  const selectedVersion = Math.max(0, ...[...selected.values()].map((entry) => entry.version));
  if (selectedVersion > 0) {
    pushWarning(warnings, {
      code: "MULTI_RELEASE_SELECTED",
      message: `已按目标 Java ${targetJavaVersion} 选择最高兼容的多版本 class（最高版本 ${selectedVersion}）。`,
    });
  }
  return [...selected.values()].sort((left, right) =>
    left.logicalName.localeCompare(right.logicalName),
  );
}

function manifestEnablesMultiRelease(content: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return false;
  }
  const unfolded = text.replace(/\r?\n /g, "");
  return /^Multi-Release:\s*true\s*$/im.test(unfolded);
}

function resolveCandidates(
  entries: Map<string, ParsedClassEntry>,
  warnings: JarInspectionWarning[],
): TestNgClassCandidate[] {
  const resolved = new Map<string, ParsedClassFile>();
  const resolving = new Set<string>();

  const resolve = (className: string): ParsedClassFile | undefined => {
    const known = resolved.get(className);
    if (known) return known;
    const entry = entries.get(className);
    if (!entry) return undefined;
    if (resolving.has(className)) {
      pushWarning(warnings, {
        code: "CLASS_INHERITANCE_CYCLE",
        message: "类继承关系形成循环，无法继续静态合并。",
        entry: entry.entryName,
      });
      return entry.parsed;
    }
    resolving.add(className);
    const parent = entry.parsed.superClassName ? resolve(entry.parsed.superClassName) : undefined;
    const reparsed = parseClassFile(entry.bytes, parent?.classTest) ?? entry.parsed;
    reparsed.candidate = mergeInheritedCandidate(reparsed, parent);
    resolving.delete(className);
    resolved.set(className, reparsed);
    return reparsed;
  };

  for (const className of entries.keys()) resolve(className);
  for (const [className, parsed] of resolved) {
    const parentName = parsed.superClassName;
    if (
      parsed.candidate &&
      parentName &&
      parentName !== "java.lang.Object" &&
      !entries.has(parentName) &&
      !parentName.startsWith("java.")
    ) {
      pushWarning(warnings, {
        code: "EXTERNAL_SUPERCLASS_NOT_SCANNED",
        message: `父类 ${parentName} 不在 JAR 内；无法静态发现其继承测试。`,
        entry: entries.get(className)?.entryName,
      });
    }
  }

  return [...resolved.values()]
    .filter(
      (
        parsed,
      ): parsed is ParsedClassFile & { candidate: NonNullable<ParsedClassFile["candidate"]> } =>
        !parsed.abstract && parsed.candidate !== null,
    )
    .map((parsed) => parsed.candidate)
    .sort((left, right) => left.className.localeCompare(right.className));
}

function mergeInheritedCandidate(
  child: ParsedClassFile,
  parent: ParsedClassFile | undefined,
): ParsedClassFile["candidate"] {
  const inheritedMethods = (parent?.candidate?.methods ?? []).filter(
    (method) => method.inheritable,
  );
  const declaredKeys = new Set(
    child.publicMethods.map((method) => `${method.methodName}\u0000${method.descriptor}`),
  );
  const ownMethods = child.candidate?.methods ?? [];
  const ownKeys = new Set(
    ownMethods.map((method) => `${method.methodName}\u0000${method.descriptor}`),
  );
  const inherited = inheritedMethods.filter((method) => {
    const key = `${method.methodName}\u0000${method.descriptor}`;
    return !declaredKeys.has(key) && !ownKeys.has(key);
  });
  const methods = [...ownMethods, ...inherited].sort((left, right) =>
    `${left.methodName}${left.descriptor}`.localeCompare(`${right.methodName}${right.descriptor}`),
  );
  if (!child.candidate && methods.length === 0) return null;
  if (child.candidate) return { ...child.candidate, methods };
  const lastDot = child.className.lastIndexOf(".");
  return {
    className: child.className,
    packageName: lastDot === -1 ? "" : child.className.slice(0, lastDot),
    simpleName: lastDot === -1 ? child.className : child.className.slice(lastDot + 1),
    superClassName: child.superClassName,
    enabled: child.classTest?.enabled ?? true,
    classLevelTest: Boolean(child.classTest),
    groups: child.classTest?.groups ?? [],
    parameters: {},
    methods,
  };
}

function applyXmlSelections(
  classes: TestNgClassCandidate[],
  selections: TestNgXmlSelection[],
  warnings: JarInspectionWarning[],
): TestNgClassCandidate[] {
  return classes.flatMap((candidate) => {
    const matching = selections.filter((selection) =>
      selectionIncludesClass(selection, candidate.className),
    );
    if (matching.length === 0) return [];
    const parameters = mergeSelectionParameters(matching, warnings, candidate.className);
    const methods = candidate.methods.map((method) => ({
      ...method,
      enabled:
        method.enabled &&
        matching.some((selection) =>
          selectionIncludesMethod(selection, candidate.className, method),
        ),
      parameters,
    }));
    return [
      {
        ...candidate,
        parameters,
        methods,
      },
    ];
  });
}

function selectionIncludesMethod(
  selection: TestNgXmlSelection,
  className: string,
  method: TestNgMethodCandidate,
): boolean {
  if (
    selection.includedGroups.length > 0 &&
    !method.groups.some((group) => selection.includedGroups.includes(group))
  ) {
    return false;
  }
  if (method.groups.some((group) => selection.excludedGroups.includes(group))) return false;
  const selectedClass = selection.selectedClasses.find((item) => item.className === className);
  if (!selectedClass) return selection.selectedClasses.length === 0;
  if (
    selectedClass.excludedMethods.some((pattern) => methodNameMatches(pattern, method.methodName))
  ) {
    return false;
  }
  return (
    selectedClass.includedMethods.length === 0 ||
    selectedClass.includedMethods.some((pattern) => methodNameMatches(pattern, method.methodName))
  );
}

function methodNameMatches(pattern: string, methodName: string): boolean {
  if (!pattern.includes("*")) return pattern === methodName;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(methodName);
}

function mergeSelectionParameters(
  selections: TestNgXmlSelection[],
  warnings: JarInspectionWarning[],
  className?: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const conflicts = new Set<string>();
  for (const selection of selections) {
    for (const [name, value] of Object.entries(selection.parameters)) {
      if (merged[name] !== undefined && merged[name] !== value) conflicts.add(name);
      else merged[name] = value;
    }
  }
  for (const name of conflicts) {
    delete merged[name];
    pushWarning(warnings, {
      code: "TESTNG_XML_PARAMETER_CONFLICT",
      message: `参数 ${name} 在多个 test 中取值冲突，未写入静态快照。`,
      entry: className ? `testng.xml:${className}` : "testng.xml",
    });
  }
  return Object.fromEntries(
    Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function dynamicSemanticWarning(
  semantic: ParsedClassFile["dynamicSemantics"][number],
  entry: string,
): JarInspectionWarning {
  const messages = {
    factory: "检测到 TestNG @Factory；实例数量和动态测试只能在受控执行期确定。",
    "data-provider": "检测到 TestNG DataProvider；静态快照保留引用，运行期数据行不会预展开。",
    listeners: "检测到 TestNG @Listeners；监听器不会扩展静态发现结果。",
  } as const;
  return {
    code: `TESTNG_${semantic.replace("-", "_").toUpperCase()}_RUNTIME_ONLY`,
    message: messages[semantic],
    entry,
  };
}
