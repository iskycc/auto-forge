import type { JarImportResult, JarInspection, TestNgClassCandidate } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import type {
  CaseCatalogRepository,
  Clock,
  ExistingSource,
  IdGenerator,
  ImportCaseRecord,
  JarDiscoveryPort,
  JarObjectStorePort,
} from "./ports";

export type ImportTestNgJarDependencies = {
  discovery: JarDiscoveryPort;
  objectStore: JarObjectStorePort;
  catalog: CaseCatalogRepository;
  clock: Clock;
  ids: IdGenerator;
};

export type ImportTestNgJarInput = {
  fileName: string;
  content: Uint8Array;
};

function duplicateResult(source: ExistingSource, inspection: JarInspection): JarImportResult {
  return {
    sourceId: source.sourceId,
    duplicate: true,
    importedClassCount: source.classCount,
    importedMethodCount: source.methodCount,
    inspection,
  };
}

function importedCases(classes: TestNgClassCandidate[], ids: IdGenerator): ImportCaseRecord[] {
  return classes.map((candidate) => ({
    caseDefinitionId: ids.next(),
    caseVersionId: ids.next(),
    candidate,
    methods: candidate.methods.map((_, methodIndex) => ({
      methodId: ids.next(),
      methodIndex,
    })),
  }));
}

function displayName(fileName: string): string {
  return fileName.replace(/\.jar$/i, "") || fileName;
}

export class ImportTestNgJarService {
  constructor(private readonly dependencies: ImportTestNgJarDependencies) {}

  async execute(input: ImportTestNgJarInput): Promise<JarImportResult> {
    const inspection = await this.dependencies.discovery.inspect(input.fileName, input.content);
    if (inspection.testClassCount === 0) {
      throw new DomainError(
        "NO_TESTNG_TESTS",
        "JAR 中没有发现带 TestNG @Test 注解的测试类或测试方法。",
      );
    }

    const existing = await this.dependencies.catalog.findSourceBySha256(inspection.sha256);
    if (existing) {
      return duplicateResult(existing, inspection);
    }

    const stored = await this.dependencies.objectStore.putJar(inspection.sha256, input.content);
    const sourceId = this.dependencies.ids.next();
    const importedAt = this.dependencies.clock.now().toISOString();

    try {
      await this.dependencies.catalog.importCatalog({
        sourceId,
        objectKey: stored.objectKey,
        displayName: displayName(input.fileName),
        importedAt,
        inspection,
        cases: importedCases(inspection.classes, this.dependencies.ids),
      });
    } catch (error) {
      const concurrentImport = await this.dependencies.catalog.findSourceBySha256(
        inspection.sha256,
      );
      if (concurrentImport) {
        return duplicateResult(concurrentImport, inspection);
      }
      if (stored.created) {
        try {
          await this.dependencies.objectStore.delete(stored.objectKey);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "JAR 目录写入失败，且无法清理已保存的对象。",
            { cause: error },
          );
        }
      }
      throw error;
    }

    return {
      sourceId,
      duplicate: false,
      importedClassCount: inspection.testClassCount,
      importedMethodCount: inspection.testMethodCount,
      inspection,
    };
  }
}
