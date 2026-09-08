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
    parseUpload: (input, limits) =>
      dispatcher.parseFile!("parse-ddt", { ...input, parseLimits: limits }) as ReturnType<
        DdtSpreadsheetPort["parseUpload"]
      >,
  };
}
