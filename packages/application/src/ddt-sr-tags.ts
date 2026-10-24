import type {
  DdtSrTagScope,
  DdtSrTagQuery,
  DdtSrTag,
  DdtSrTagPage,
  DdtSrTagGroups,
  DdtSrTagMembers,
  DdtSrTagFilter,
  DdtSrTagMutation,
  SrTagClassification,
  SrTagImportRow,
} from "@autoforge/contracts";
import type { Clock, IdGenerator } from "./ports";

export interface DdtSrTagRepository {
  list(scope: DdtSrTagScope, query: DdtSrTagQuery): Promise<DdtSrTagPage>;
  groups(scope: DdtSrTagScope, query: DdtSrTagQuery): Promise<DdtSrTagGroups>;
  lookup(scope: DdtSrTagScope, srNums: string[]): Promise<Record<string, DdtSrTag[]>>;
  create(scope: DdtSrTagScope, tag: DdtSrTag, recordedAt: string): Promise<DdtSrTag>;
  assign(
    scope: DdtSrTagScope,
    input: { tagId: string; srNum: string; assigned: boolean },
    recordedAt: string,
  ): Promise<void>;
  findSrKeys(scope: DdtSrTagScope, srNums: string[]): Promise<string[]>;
  classifications(
    scope: DdtSrTagScope,
    cursor?: string,
  ): Promise<{ items: SrTagClassification[]; nextCursor?: string }>;
  importPage(
    scope: DdtSrTagScope,
    rows: Array<SrTagImportRow & { tagId: string }>,
    recordedAt: string,
  ): Promise<number>;
  members(scope: DdtSrTagScope, suiteId: string, filter: DdtSrTagFilter): Promise<DdtSrTagMembers>;
}

/** Version-scoped labels are independent of stage-scoped SR execution-class associations. */
export class DdtSrTagService {
  constructor(
    private readonly repository: DdtSrTagRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}
  list(...args: Parameters<DdtSrTagRepository["list"]>) {
    return this.repository.list(...args);
  }
  groups(...args: Parameters<DdtSrTagRepository["groups"]>) {
    return this.repository.groups(...args);
  }
  lookup(...args: Parameters<DdtSrTagRepository["lookup"]>) {
    return this.repository.lookup(...args);
  }
  members(...args: Parameters<DdtSrTagRepository["members"]>) {
    return this.repository.members(...args);
  }
  async mutate(scope: DdtSrTagScope, input: DdtSrTagMutation) {
    const recordedAt = this.clock.now().toISOString();
    if (input.operation === "create")
      return this.repository.create(scope, { id: this.ids.next(), name: input.name }, recordedAt);
    await this.repository.assign(scope, input, recordedAt);
    return { saved: true };
  }
}
