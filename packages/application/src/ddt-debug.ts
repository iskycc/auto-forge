import {
  DomainError,
  normalizeDdtCaseData,
  ddtCaseCell,
  type DdtCase,
  type DdtCaseData,
  type DdtCaseSummary,
  type DdtScope,
} from "@autoforge/domain";
import type { Clock, DdtRepository, IdGenerator } from "./ports";
import type { DdtImportCaseOutcome } from "./ddt-types";

export type DdtDebugScope = DdtScope & { ownerUserId: string };
export type DdtDebugAccess = { ownerUserId: string; accessKey: string };
export type DdtDebugWrite = {
  scope: DdtDebugScope;
  id: string;
  caseId: string;
  data: DdtCaseData;
  sourceName: string;
  now: string;
  strategy: "overwrite" | "skip" | "error";
  expectedRevision?: number;
  importRowKey?: string;
};
export interface DdtDebugRepository {
  workspace(scope: DdtDebugScope, accessKey: string): Promise<DdtDebugAccess>;
  hasAccess(scope: DdtDebugScope, accessKey: string): Promise<boolean>;
  findCaseData(scope: DdtDebugScope, caseIds: string[]): Promise<Map<string, DdtCaseData>>;
  get(scope: DdtDebugScope, caseId: string): Promise<DdtCase | null>;
  list(
    scope: DdtDebugScope,
    query: { query: string; cursor?: string; limit: number },
  ): Promise<{ items: DdtCaseSummary[]; nextCursor?: string }>;
  write(input: DdtDebugWrite): Promise<DdtImportCaseOutcome>;
}

export class DdtDebugService {
  constructor(
    private readonly repository: DdtDebugRepository,
    private readonly formal: DdtRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}
  workspace(scope: DdtDebugScope) {
    return this.repository.workspace(scope, this.ids.next());
  }
  list(scope: DdtDebugScope, query: { query: string; cursor?: string; limit: number }) {
    return this.repository.list(scope, query);
  }
  async get(scope: DdtDebugScope, caseId: string): Promise<DdtCase> {
    const item = await this.repository.get(scope, caseId);
    if (!item)
      throw new DomainError(
        "DDT_CASE_NOT_FOUND",
        "个人调试库中没有这个 CaseId，请先导入或复制现有用例。",
      );
    return item;
  }
  async readPublic(scope: DdtDebugScope, accessKey: string, caseId: string): Promise<DdtCaseData> {
    if (!(await this.repository.hasAccess(scope, accessKey)))
      throw new DomainError("DDT_CASE_NOT_FOUND", "调试数据地址无效。");
    return (await this.get(scope, caseId)).data;
  }
  async copy(scope: DdtDebugScope, caseId: string): Promise<DdtCase> {
    const original = await this.formal.getCase(scope, caseId);
    if (!original) throw new DomainError("DDT_CASE_NOT_FOUND", "正式用例不存在。");
    // Selecting a formal case again must never overwrite the user's edited account data.
    await this.repository.write({
      scope,
      caseId: original.caseId,
      id: this.ids.next(),
      data: original.data,
      sourceName: original.sourceName,
      now: this.clock.now().toISOString(),
      strategy: "skip",
    });
    return this.get(scope, caseId);
  }
  async update(
    scope: DdtDebugScope,
    caseId: string,
    data: DdtCaseData,
    revision: number,
  ): Promise<DdtCase> {
    const next = normalizeDdtCaseData(data);
    if (
      String(ddtCaseCell(next, "CaseID")).toLocaleLowerCase("en-US") !==
      caseId.toLocaleLowerCase("en-US")
    )
      throw new DomainError("DDT_CASE_ID_IMMUTABLE", "编辑调试数据时不能修改 CaseId。");
    await this.repository.write({
      scope,
      caseId,
      id: this.ids.next(),
      data: next,
      sourceName: "个人调试编辑",
      now: this.clock.now().toISOString(),
      strategy: "overwrite",
      expectedRevision: revision,
    });
    return this.get(scope, caseId);
  }
}
