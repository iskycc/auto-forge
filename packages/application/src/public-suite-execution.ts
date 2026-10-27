import {
  publicSuiteExecutionPath,
  publicSuiteViewSchema,
  publicSuiteExecutionResultSchema,
  startPublicSuiteExecutionSchema,
  type ExecutionActor,
  type PublicSuiteBatch,
  type PublicSuiteView,
  type StartPublicSuiteExecution,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type {
  CaseSuiteRepository,
  Clock,
  IdentityAccessRepository,
  ProjectStructureRepository,
} from "./ports";
import type { RunBatchSchedulingService } from "./schedule-run-batches";
import type { ExecutionControlService } from "./control-executions";
import type { PublicExecutionAccessService } from "./public-execution-access";

export interface PublicSuiteExecutionRepository {
  publish(suiteId: string, publisherId: string, createdAt: string): Promise<void>;
  revoke(suiteId: string, publisherId: string, revokedAt: string): Promise<void>;
  publisher(suiteId: string, publisherId: string): Promise<ExecutionActor | null>;
  executions(suiteId: string): Promise<{ active: PublicSuiteBatch[]; recent: PublicSuiteBatch[] }>;
  batch(suiteId: string, batchId: string): Promise<PublicSuiteBatch | null>;
  replay(suiteId: string, publisherId: string, requestKey: string): Promise<string | null>;
}

/** A published task is an explicit execution grant; project RBAC remains at publication. */
export class PublicSuiteExecutionService {
  constructor(
    private readonly links: PublicSuiteExecutionRepository,
    private readonly suites: Pick<CaseSuiteRepository, "getSummary">,
    private readonly projects: Pick<IdentityAccessRepository, "listProjects">,
    private readonly structures: Pick<ProjectStructureRepository, "list">,
    private readonly runs: Pick<RunBatchSchedulingService, "create" | "getSummary">,
    private readonly control: Pick<ExecutionControlService, "terminateBatch">,
    private readonly publicAccess: Pick<PublicExecutionAccessService, "publishBatch">,
    private readonly clock: Clock,
  ) {}

  async publish(suiteId: string, publisherId: string): Promise<string> {
    const suite = await this.requireSuite(suiteId);
    if (!suite.enabled || suite.status !== "active")
      throw new DomainError("CASE_SUITE_DISABLED", "请先启用任务再生成公开执行链接。");
    await this.links.publish(suiteId, publisherId, this.clock.now().toISOString());
    return publicSuiteExecutionPath(suiteId, publisherId);
  }

  async revoke(suiteId: string, publisherId: string): Promise<void> {
    await this.links.revoke(suiteId, publisherId, this.clock.now().toISOString());
  }

  async linkPath(suiteId: string, publisherId: string): Promise<string | null> {
    return (await this.links.publisher(suiteId, publisherId))
      ? publicSuiteExecutionPath(suiteId, publisherId)
      : null;
  }

  async read(suiteId: string, publisherId: string): Promise<PublicSuiteView> {
    const publisher = await this.requirePublisher(suiteId, publisherId);
    const suite = await this.requireSuite(suiteId);
    const [projects, structure, executions] = await Promise.all([
      this.projects.listProjects([suite.projectId]),
      this.structures.list(suite.projectId),
      this.links.executions(suiteId),
    ]);
    const unavailableReason =
      !suite.enabled || suite.status !== "active"
        ? "任务已停用或归档，暂不能执行。"
        : suite.caseCount === 0
          ? "任务没有可执行用例。"
          : null;
    return publicSuiteViewSchema.parse({
      suiteId,
      name: suite.name,
      description: suite.description ?? "",
      projectName: projects[0]?.name ?? "所属项目",
      versionName:
        structure.versions.find((version) => version.id === suite.policy.projectVersionId)?.name ??
        "未关联版本",
      caseCount: suite.caseCount,
      concurrency: suite.policy.concurrency,
      retryLimit: suite.policy.retryLimit,
      adapterEnabled: suite.policy.adapter.enabled,
      environmentAddresses: suite.policy.adapter.enabled
        ? suite.policy.adapter.environmentAddresses
        : [],
      publisher,
      executable: !unavailableReason,
      unavailableReason,
      ...executions,
      generatedAt: this.clock.now().toISOString(),
    });
  }

  async start(
    suiteId: string,
    publisherId: string,
    input: StartPublicSuiteExecution,
    actor: ExecutionActor,
  ) {
    const validated = startPublicSuiteExecutionSchema.parse(input);
    const publisher = await this.requirePublisher(suiteId, publisherId);
    const replay = await this.links.replay(suiteId, publisherId, validated.requestKey);
    const batch = replay
      ? await this.runs.getSummary(replay)
      : await this.runs.create(
          { suiteId, delaySeconds: validated.delaySeconds },
          { username: actor.username, source: actor.source },
          {
            publisher,
            initiator: actor,
            requestKey: validated.requestKey,
            ...(validated.environmentAddresses
              ? { environmentAddresses: validated.environmentAddresses }
              : {}),
          },
        );
    const progressPath = await this.publicAccess.publishBatch(batch.id, actor.id);
    return publicSuiteExecutionResultSchema.parse({ batchId: batch.id, progressPath });
  }

  async terminate(
    suiteId: string,
    publisherId: string,
    batchId: string,
    actor: ExecutionActor,
  ): Promise<number> {
    await this.requirePublisher(suiteId, publisherId);
    const batch = await this.links.batch(suiteId, batchId);
    // The grant controls only executions created through this task's public entry.
    if (!batch?.publicExecution)
      throw new DomainError("RUN_BATCH_NOT_FOUND", "该批次不属于此任务的公开执行记录。");
    return this.control.terminateBatch(actor.id, batchId, "从任务公开执行页终止", actor);
  }

  private async requirePublisher(suiteId: string, publisherId: string): Promise<ExecutionActor> {
    const publisher = await this.links.publisher(suiteId, publisherId);
    if (!publisher)
      throw new DomainError(
        "PUBLIC_SUITE_LINK_NOT_FOUND",
        "公开执行链接不存在、已撤销或分享人已停用。",
      );
    return publisher;
  }

  private async requireSuite(suiteId: string) {
    const suite = await this.suites.getSummary(suiteId);
    if (!suite) throw new DomainError("PUBLIC_SUITE_LINK_NOT_FOUND", "任务已删除或暂不可用。");
    return suite;
  }
}
