import { DomainError } from "@autoforge/domain";

import type { CaseCatalogRepository, JarObjectStorePort } from "./ports";

export class CaseSourceService {
  constructor(
    private readonly catalog: CaseCatalogRepository,
    private readonly objectStore: JarObjectStorePort,
  ) {}

  async listObjects(input: { cursor?: string; limit: number; prefix?: string }) {
    const page = await this.objectStore.list(input);
    return { storage: this.objectStore.storageKind, ...page } as const;
  }

  async get(sourceId: string) {
    const source = await this.catalog.getSource(sourceId);
    if (!source) {
      throw new DomainError("CASE_SOURCE_NOT_FOUND", "指定的 JAR 来源不存在。");
    }
    return source;
  }

  async setAuthoritative(sourceId: string) {
    const source = await this.catalog.getSource(sourceId);
    if (!source) {
      throw new DomainError("CASE_SOURCE_NOT_FOUND", "指定的 JAR 来源不存在。");
    }
    return this.catalog.setAuthoritativeSource(sourceId);
  }
}
