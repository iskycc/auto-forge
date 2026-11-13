import {
  publicSuiteExecutionPath,
  PUBLIC_SUITE_NO_ENVIRONMENT_CONFIRMATION,
  publicSuiteTerminationConfirmationSchema,
  type PublicSuiteTerminationConfirmation,
  changePublicSuiteEnvironmentSchema,
  type PublicSuiteEnvironmentState,
  type ChangePublicSuiteEnvironment,
  publicSuiteViewSchema,
  publicSuiteExecutionResultSchema,
  startPublicSuiteExecutionSchema,
  type ExecutionActor,
  type PublicSuiteBatch,
  type PublicSuiteView,
  type StartPublicSuiteExecution,
} from "@autoforge/contracts";
import { DomainError, assertCaseSuiteLockOwner, sameEnvironmentAddresses } from "@autoforge/domain";
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
  environment(suiteId: string, publisherId: string): Promise<PublicSuiteEnvironmentState | null>;
  changeEnvironment(
    suiteId: string,
    publisherId: string,
    input: ChangePublicSuiteEnvironment,
    actor: ExecutionActor,
    modifiedAt: string,
  ): Promise<PublicSuiteEnvironmentState>;
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
    private readonly control: Pick<
      ExecutionControlService,
      "terminateBatch" | "changeBatchScheduling"
    >,
    private readonly publicAccess: Pick<PublicExecutionAccessService, "publishBatch">,
    private readonly clock: Clock,
  ) {}

  async publish(suiteId: string, publisherId: string): Promise<string> {
    const suite = await this.requireSuite(suiteId);
    assertCaseSuiteLockOwner(suite, publisherId);
    if (!suite.enabled || suite.status !== "active")
      throw new DomainError("CASE_SUITE_DISABLED", "请先启用任务再生成公开执行链接。");
    await this.links.publish(suiteId, publisherId, this.clock.now().toISOString());
    return publicSuiteExecutionPath(suiteId, publisherId);
  }

  async revoke(suiteId: string, publisherId: string): Promise<void> {
    assertCaseSuiteLockOwner(await this.requireSuite(suiteId), publisherId);
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
    const [projects, structure, executions, environment] = await Promise.all([
      this.projects.listProjects([suite.projectId]),
      this.structures.list(suite.projectId),
      this.links.executions(suiteId),
      this.requireEnvironment(suiteId, publisherId),
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
      unlimitedRetries: suite.policy.unlimitedRetries ?? false,
      adapterEnabled: suite.policy.adapter.enabled,
      environmentAddresses: suite.policy.adapter.enabled
        ? suite.policy.adapter.environmentAddresses
        : [],
      publisher,
      environment,
      executable: !unavailableReason,
      unavailableReason,
      ...executions,
      generatedAt: this.clock.now().toISOString(),
    });
  }

  async changeEnvironment(
    suiteId: string,
    publisherId: string,
    input: ChangePublicSuiteEnvironment,
    actor: ExecutionActor,
  ): Promise<PublicSuiteEnvironmentState> {
    const validated = changePublicSuiteEnvironmentSchema.parse(input);
    await this.requirePublisher(suiteId, publisherId);
    const suite = await this.requireSuite(suiteId);
    if (!suite.enabled || suite.status !== "active")
      throw new DomainError("CASE_SUITE_DISABLED", "任务已停用或归档，不能修改执行环境。");
    if (!suite.policy.adapter.enabled)
      throw new DomainError("RUN_BATCH_PREFLIGHT_FAILED", "任务未启用 Adapter，不能修改环境 IP。");
    // A link grants execution configuration only; the task's lock and default policy are untouched.
    return this.links.changeEnvironment(
      suiteId,
      publisherId,
      validated,
      actor,
      this.clock.now().toISOString(),
    );
  }

  private async requireEnvironment(suiteId: string, publisherId: string) {
    const environment = await this.links.environment(suiteId, publisherId);
    if (!environment)
      throw new DomainError("PUBLIC_SUITE_LINK_NOT_FOUND", "公开执行链接已撤销或暂不可用。");
    return environment;
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
    const environment = replay ? null : await this.requireEnvironment(suiteId, publisherId);
    if (
      environment &&
      validated.environmentRevision !== undefined &&
      environment.revision !== validated.environmentRevision
    )
      throw new DomainError(
        "PUBLIC_SUITE_ENVIRONMENT_REVISION_CONFLICT",
        "环境 IP 已被其他人修改，请刷新后确认最新 IP 再执行。",
      );
    const useShared = validated.environmentAddresses === undefined;
    const sharedEnabled =
      useShared && !replay ? (await this.requireSuite(suiteId)).policy.adapter.enabled : false;
    const batch = replay
      ? await this.runs.getSummary(replay)
      : await this.runs.create(
          { suiteId, delaySeconds: validated.delaySeconds },
          { username: actor.username, source: actor.source },
          {
            publisher,
            initiator: actor,
            requestKey: validated.requestKey,
            ...(useShared && environment
              ? {
                  environmentRevision: environment.revision,
                  environmentChange: sharedEnabled ? environment.change : null,
                  ...(sharedEnabled && environment.change?.addresses
                    ? { environmentAddresses: environment.change.addresses }
                    : {}),
                }
              : {}),
            ...(validated.environmentAddresses
              ? { environmentAddresses: validated.environmentAddresses }
              : {}),
          },
        );
    const progressPath = await this.publicAccess.publishBatch(batch.id, actor.id);
    return publicSuiteExecutionResultSchema.parse({ batchId: batch.id, progressPath });
  }

  async changeScheduling(
    suiteId: string,
    publisherId: string,
    batchId: string,
    actor: ExecutionActor,
    action: "pause" | "resume",
  ) {
    await this.requirePublisher(suiteId, publisherId);
    const batch = await this.links.batch(suiteId, batchId);
    if (!batch?.publicExecution)
      throw new DomainError("RUN_BATCH_NOT_FOUND", "该批次不属于此任务的公开执行记录。");
    return this.control.changeBatchScheduling(actor.id, batchId, action);
  }

  async terminate(
    suiteId: string,
    publisherId: string,
    batchId: string,
    actor: ExecutionActor,
    confirmation?: PublicSuiteTerminationConfirmation,
  ): Promise<number> {
    await this.requirePublisher(suiteId, publisherId);
    const batch = await this.links.batch(suiteId, batchId);
    // The grant controls only executions created through this task's public entry.
    if (!batch?.publicExecution)
      throw new DomainError("RUN_BATCH_NOT_FOUND", "该批次不属于此任务的公开执行记录。");
    if (batch.initiator?.id !== actor.id) {
      if (!confirmation || !batch.initiator)
        throw new DomainError(
          "PUBLIC_SUITE_TERMINATION_CONFIRMATION_REQUIRED",
          "您不是此批次的拉起人，请填写拉起人账号和本批次全部环境 IP 后再确认终止。",
        );
      const validated = publicSuiteTerminationConfirmationSchema.parse(confirmation);
      const matchesEnvironment = sameEnvironmentAddresses(
        batch.environmentAddresses,
        validated.environmentAddresses,
      );
      const confirmsEmptyEnvironment =
        batch.environmentAddresses.length > 0 ||
        validated.noEnvironmentConfirmation === PUBLIC_SUITE_NO_ENVIRONMENT_CONFIRMATION;
      if (
        validated.initiatorUsername !== batch.initiator.username ||
        !matchesEnvironment ||
        !confirmsEmptyEnvironment
      )
        throw new DomainError(
          "PUBLIC_SUITE_TERMINATION_CONFIRMATION_MISMATCH",
          "确认信息不匹配：请核对拉起人账号和该批次实际使用的全部环境 IP；不要填写任务默认 IP 或其他批次的 IP。",
        );
    }
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
