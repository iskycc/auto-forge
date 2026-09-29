import {
  DDT_CHANGE_REQUEST_CASE_LIMIT,
  type SubmitDdtChangeRequest,
  type ReviewDdtChangeRequest,
} from "@autoforge/contracts";
import {
  DomainError,
  diffDdtCaseData,
  validateDdtCaseAgainstTemplate,
  ddtCaseCell,
  type DdtCaseData,
  type DdtScope,
} from "@autoforge/domain";
import type { Clock, DdtRepository, IdGenerator } from "./ports";
import type { DdtDebugRepository, DdtDebugScope } from "./ddt-debug";

export type DdtChangeStatus = "pending" | "approved" | "rejected" | "withdrawn";
export type DdtChangeItem = {
  caseId: string;
  baseId: string | null;
  baseRevision: number | null;
  personalRevision: number;
  before: DdtCaseData;
  after: DdtCaseData;
};
export type DdtChangeCandidate = Omit<DdtChangeItem, "before" | "after"> & {
  changeCount: number;
};
export type DdtChangeRequestSummary = DdtScope & {
  id: string;
  title: string;
  description: string;
  ownerUserId: string;
  ownerName: string;
  status: DdtChangeStatus;
  caseCount: number;
  createdAt: string;
  reviewedAt: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewComment: string;
};
export type DdtChangeRequest = DdtChangeRequestSummary & { items: DdtChangeItem[] };
export type DdtChangeRequestQuery = {
  ownerUserId?: string;
  status?: DdtChangeStatus;
  cursor?: string;
  limit: number;
};
export interface DdtChangeRequestRepository {
  get(scope: DdtScope, id: string): Promise<DdtChangeRequest | null>;
  list(
    scope: DdtScope,
    query: DdtChangeRequestQuery,
  ): Promise<{
    items: DdtChangeRequestSummary[];
    nextCursor?: string;
  }>;
  create(request: DdtChangeRequest): Promise<void>;
  decide(input: {
    request: DdtChangeRequest;
    status: Exclude<DdtChangeStatus, "pending">;
    actorId: string;
    comment: string;
    now: string;
    caseIds: string[];
    historyIds: string[];
  }): Promise<void>;
}

const MAXIMUM_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const normalizeId = (id: string) => id.toLocaleLowerCase("en-US");

export class DdtChangeRequestService {
  constructor(
    private readonly requests: DdtChangeRequestRepository,
    private readonly personal: DdtDebugRepository,
    private readonly formal: DdtRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async candidates(scope: DdtDebugScope, query: { query: string; cursor?: string; limit: number }) {
    const page = await this.personal.list(scope, { ...query, limit: Math.min(query.limit, 20) });
    const items: DdtChangeCandidate[] = [];
    // Read bodies one case at a time; lists never return private account values.
    for (const candidate of page.items) {
      const item = await this.compare(scope, candidate.caseId);
      const changeCount = diffDdtCaseData(item.before, item.after).length;
      if (changeCount) {
        items.push({
          caseId: item.caseId,
          personalRevision: item.personalRevision,
          baseId: item.baseId,
          baseRevision: item.baseRevision,
          changeCount,
        });
      }
    }
    return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async compare(scope: DdtDebugScope, caseId: string): Promise<DdtChangeItem> {
    const personal = await this.personal.get(scope, caseId);
    if (!personal) throw new DomainError("DDT_CASE_NOT_FOUND", "个人调试用例不存在，请重新选择。");
    const formal = await this.formal.getCase(scope, caseId);
    return {
      caseId: personal.caseId,
      personalRevision: personal.revision,
      baseId: formal?.id ?? null,
      baseRevision: formal?.revision ?? null,
      before: formal?.data ?? {},
      after: personal.data,
    };
  }

  list(scope: DdtScope, query: DdtChangeRequestQuery) {
    return this.requests.list(scope, query);
  }

  async get(scope: DdtScope, id: string, actorId: string, canReview: boolean) {
    const request = await this.requests.get(scope, id);
    if (!request || (!canReview && request.ownerUserId !== actorId))
      throw new DomainError("DDT_CHANGE_REQUEST_NOT_FOUND", "变更申请不存在或不可访问。");
    return request;
  }

  async submit(scope: DdtDebugScope, input: SubmitDdtChangeRequest) {
    const existing = await this.requests.get(scope, input.id);
    if (existing) {
      if (existing.ownerUserId !== scope.ownerUserId)
        throw new DomainError("DDT_CHANGE_REQUEST_CONFLICT", "变更标识已使用，请重新提交。");
      return existing;
    }
    if (
      !input.cases.length ||
      input.cases.length > DDT_CHANGE_REQUEST_CASE_LIMIT ||
      new Set(input.cases.map((item) => normalizeId(item.caseId))).size !== input.cases.length
    )
      throw new DomainError("DDT_CHANGE_SELECTION_INVALID", "请选取 1–50 个不重复的差异用例。");
    const items: DdtChangeItem[] = [];
    let bytes = 0;
    for (const selection of input.cases) {
      const item = await this.compare(scope, selection.caseId);
      if (
        item.personalRevision !== selection.personalRevision ||
        item.baseId !== selection.baseId ||
        item.baseRevision !== selection.baseRevision
      )
        throw new DomainError(
          "DDT_CHANGE_PREVIEW_CONFLICT",
          `${item.caseId} 已发生变化，请刷新差异后重新选择。`,
        );
      if (selection.fields) {
        const changes = diffDdtCaseData(item.before, item.after);
        if (
          !selection.fields.length ||
          selection.fields.some((field) => !changes.some((change) => change.field === field))
        )
          throw new DomainError(
            "DDT_CHANGE_FIELDS_INVALID",
            "所选字段不在当前差异中，请重新选择。",
          );
        const selected: DdtCaseData = { ...item.before };
        for (const field of selection.fields) {
          if (Object.hasOwn(item.after, field))
            Object.defineProperty(selected, field, {
              value: item.after[field],
              enumerable: true,
              configurable: true,
              writable: true,
            });
          else delete selected[field];
        }
        item.after = selected;
      }
      await this.validate(scope, item);
      if (!diffDdtCaseData(item.before, item.after).length)
        throw new DomainError("DDT_CHANGE_EMPTY", `${item.caseId} 没有需要提交的差异。`);
      bytes += new TextEncoder().encode(JSON.stringify(item)).length;
      if (bytes > MAXIMUM_SNAPSHOT_BYTES)
        throw new DomainError(
          "DDT_CHANGE_TOO_LARGE",
          "本次差异快照超过 4 MiB，请减少用例或字段后分批提交。",
        );
      items.push(item);
    }
    const request: DdtChangeRequest = {
      projectId: scope.projectId,
      projectVersionId: scope.projectVersionId,
      testStageId: scope.testStageId,
      id: input.id,
      title: input.title,
      description: input.description,
      ownerUserId: scope.ownerUserId,
      ownerName: "",
      status: "pending",
      caseCount: items.length,
      createdAt: this.clock.now().toISOString(),
      reviewedAt: null,
      reviewerId: null,
      reviewerName: null,
      reviewComment: "",
      items,
    };
    await this.requests.create(request);
    return this.get(scope, request.id, scope.ownerUserId, false);
  }

  async review(
    scope: DdtScope,
    id: string,
    actorId: string,
    canReview: boolean,
    input: ReviewDdtChangeRequest,
  ) {
    const request = await this.get(scope, id, actorId, canReview);
    if (input.action === "withdraw" ? request.ownerUserId !== actorId : !canReview)
      throw new DomainError("AUTH_FORBIDDEN", "仅提交人可以撤回；审核需要当前项目的用例管理权限。");
    const status = { approve: "approved", reject: "rejected", withdraw: "withdrawn" }[
      input.action
    ] as Exclude<DdtChangeStatus, "pending">;
    if (request.status === status) return request;
    if (request.status !== "pending")
      throw new DomainError("DDT_CHANGE_REQUEST_CONFLICT", "申请已处理，请刷新列表查看最新状态。");
    if (input.action === "reject" && !input.comment.trim())
      throw new DomainError("DDT_CHANGE_REASON_REQUIRED", "退回时请填写原因。");
    if (input.action === "approve")
      for (const item of request.items) await this.validate(scope, item);
    await this.requests.decide({
      request,
      status,
      actorId,
      comment: input.comment,
      now: this.clock.now().toISOString(),
      caseIds: request.items.map(() => this.ids.next()),
      historyIds: request.items.map(() => this.ids.next()),
    });
    return this.get(scope, id, actorId, canReview);
  }

  private async validate(scope: DdtScope, item: DdtChangeItem) {
    const template = await this.formal.getTemplateForSrNum(
      scope,
      String(ddtCaseCell(item.after, "srNum") ?? ""),
    );
    const validated = validateDdtCaseAgainstTemplate(item.after, template, false);
    if (validated.errors.length)
      throw new DomainError(
        "DDT_TEMPLATE_VALIDATION_FAILED",
        `${item.caseId}：${validated.errors.map((issue) => issue.message).join("；")}`,
      );
    if (normalizeId(String(ddtCaseCell(validated.data, "CaseID"))) !== normalizeId(item.caseId))
      throw new DomainError("DDT_CASE_ID_IMMUTABLE", "提交变更不能修改 CaseId。");
    item.after = validated.data;
  }
}
