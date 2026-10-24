import { DomainError } from "@autoforge/domain";
import type {
  CreateProjectVersionCopy,
  JobEnvelope,
  ProjectVersionCopy,
} from "@autoforge/contracts";
import type { Clock, IdGenerator } from "./ports";
import type { ProjectVersionCopyRepository, VersionCopyState } from "./project-version-copy-ports";
import { publicVersionCopy } from "./copy-project-version";

/** Request handlers only persist small commands; snapshots, files and execution history stay in workers. */
export class ProjectVersionCopyRequests {
  constructor(
    private readonly dependencies: {
      repository: ProjectVersionCopyRepository;
      clock: Clock;
      ids: IdGenerator;
      authorize: (
        actorId: string,
        sourceProjectId: string,
        targetProjectId: string,
      ) => Promise<void>;
    },
  ) {}
  async create(input: CreateProjectVersionCopy, actorId: string): Promise<ProjectVersionCopy> {
    await this.dependencies.authorize(actorId, input.sourceProjectId, input.targetProjectId);
    const id = this.dependencies.ids.next();
    return publicVersionCopy(
      await this.dependencies.repository.create({
        ...input,
        id,
        allocatedTargetVersionId: this.dependencies.ids.next(),
        actorId,
        now: this.dependencies.clock.now().toISOString(),
        job: this.envelope(id),
      }),
    );
  }
  async listTargets(
    sourceProjectId: string,
    targetProjectId: string,
    actorId: string,
    afterId?: string,
  ) {
    await this.dependencies.authorize(actorId, sourceProjectId, targetProjectId);
    return this.dependencies.repository.listTargets(targetProjectId, afterId);
  }
  async get(id: string): Promise<VersionCopyState> {
    const state = await this.dependencies.repository.get(id);
    if (!state) throw new DomainError("VERSION_COPY_NOT_FOUND", "版本复制任务不存在。");
    return state;
  }
  async list(
    projectIds: readonly string[] | undefined,
    projectId: string,
  ): Promise<ProjectVersionCopy[]> {
    return (await this.dependencies.repository.list(projectIds, projectId)).map(publicVersionCopy);
  }
  async action(
    id: string,
    action: "retry" | "cancel",
    actorId: string,
  ): Promise<ProjectVersionCopy> {
    const state = await this.get(id);
    await this.dependencies.authorize(actorId, state.sourceProjectId, state.targetProjectId);
    return publicVersionCopy(
      await this.dependencies.repository.action(
        id,
        action,
        this.dependencies.clock.now().toISOString(),
        this.envelope(id),
      ),
    );
  }
  private envelope(id: string): JobEnvelope {
    const messageId = this.dependencies.ids.next();
    return {
      schemaVersion: 1,
      messageId,
      runId: id,
      attempt: 1,
      createdAt: this.dependencies.clock.now().toISOString(),
      priority: -1000,
      deduplicationKey: `project-version-copy:${id}:${messageId}`,
      kind: "project-version-copy",
      payload: { copyId: id },
    };
  }
}
