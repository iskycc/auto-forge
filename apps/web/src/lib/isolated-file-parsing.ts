import { parsedSrTagImportSchema, ddtImportRowShapeSchema } from "@autoforge/contracts";
import type { DdtSpreadsheetPort, JarDiscoveryPort } from "@autoforge/application";
import type { WorkDispatcher } from "./work-runtime";

export function isolatedJarDiscovery(
  local: JarDiscoveryPort,
  dispatcher: WorkDispatcher | undefined,
): JarDiscoveryPort {
  if (!dispatcher?.parseFile) return local;
  return {
    inspect: (fileName, content) =>
      dispatcher.parseFile!("inspect-jar", { fileName, content }) as ReturnType<
        JarDiscoveryPort["inspect"]
      >,
    readSource: (content, reference) =>
      dispatcher.parseFile!("read-jar-source", { content, reference }) as ReturnType<
        JarDiscoveryPort["readSource"]
      >,
  };
}

export function isolatedDdtSpreadsheets(
  local: DdtSpreadsheetPort,
  dispatcher: WorkDispatcher | undefined,
): DdtSpreadsheetPort {
  if (!dispatcher?.parseFile) return local;
  return {
    parseUpload: async (input, limits) => {
      const files = (await dispatcher.parseFile!("parse-ddt", {
        ...input,
        parseLimits: limits,
        compactRows: true,
      })) as Awaited<ReturnType<DdtSpreadsheetPort["parseUpload"]>>;
      return files.map((file) =>
        file.rowShape ? { ...file, rowShape: ddtImportRowShapeSchema.parse(file.rowShape) } : file,
      );
    },
  };
}

export function isolatedSrTagSpreadsheets(
  local: import("@autoforge/application").SrTagSpreadsheetPort,
  dispatcher: WorkDispatcher | undefined,
): import("@autoforge/application").SrTagSpreadsheetPort {
  return {
    parse: async (content, fileName) =>
      parsedSrTagImportSchema.parse(
        dispatcher?.parseFile
          ? await dispatcher.parseFile("parse-sr-tags", { content, fileName })
          : await local.parse(content, fileName),
      ),
  };
}
