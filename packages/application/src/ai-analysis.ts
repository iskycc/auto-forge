import {
  updateAiModelConfigurationSchema,
  createAiAnalysisSchema,
  type AiAnalysisJob,
  type AiModelConfigurationView,
} from "@autoforge/contracts";
import {
  DomainError,
  projectIdsForPermission,
  type AuthenticatedIdentity,
  type Permission,
} from "@autoforge/domain";
import type { AiAnalysisRepository, AiModelGatewayPort } from "./ai-analysis-ports";
import type {
  CachePort,
  Clock,
  IdGenerator,
  IdentityAccessRepository,
  RunBatchRepository,
  SecretCipherPort,
} from "./ports";

export const AI_KEY_PURPOSE = "ai-model-api-key-v1";
export function assertAiPermission(
  identity: AuthenticatedIdentity,
  projectId: string,
  write = false,
) {
  for (const permission of [
    "run.read",
    "case.read",
    "log.read",
    write ? "analysis.ai.create" : "analysis.ai.read",
  ] as Permission[]) {
    if (
      !identity.systemPermissions.includes(permission) &&
      !identity.projectPermissions[projectId]?.includes(permission)
    )
      throw new DomainError("AUTH_FORBIDDEN", "没有读取本项目执行证据或进行 AI 初析的权限。");
  }
}
export class AiAnalysisService {
  constructor(
    readonly repository: AiAnalysisRepository,
    private readonly batches: RunBatchRepository,
    private readonly cipher: SecretCipherPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly cache?: CachePort,
    private readonly report: (error: unknown) => void = () => {},
  ) {}
  async configuration(): Promise<AiModelConfigurationView> {
    const record = await this.repository.configuration();
    return {
      revision: record.revision,
      configuration: record.configuration,
      apiKeyConfigured: !!record.encryptedKey,
    };
  }
  async configure(input: unknown) {
    const parsed = updateAiModelConfigurationSchema.parse(input);
    const current = await this.repository.configuration();
    const encryptedKey =
      parsed.apiKey === undefined
        ? current.encryptedKey
        : parsed.apiKey
          ? this.cipher.encrypt(parsed.apiKey, AI_KEY_PURPOSE)
          : null;
    if (
      !(await this.repository.saveConfiguration(
        { revision: parsed.revision + 1, configuration: parsed.configuration, encryptedKey },
        parsed.revision,
      ))
    )
      throw new DomainError("REVISION_CONFLICT", "模型配置已变更，请刷新后重试。");
    return this.configuration();
  }
  async check(input: unknown, gateway: AiModelGatewayPort, signal: AbortSignal) {
    const parsed = updateAiModelConfigurationSchema.parse(input);
    const current = await this.repository.configuration();
    const apiKey =
      parsed.apiKey ??
      (current.encryptedKey ? this.cipher.decrypt(current.encryptedKey, AI_KEY_PURPOSE) : "");
    const started = this.clock.now().getTime();
    const reply = await gateway.complete({
      configuration: { ...parsed.configuration, outputTokens: 512 },
      apiKey,
      messages: [
        {
          role: "system",
          content: "这是连接与工具兼容检查，没有真实用例数据。请调用 connection_check，参数为 {}。",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "connection_check",
            description: "检查工具调用能力。",
            strict: true,
            parameters: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        },
      ],
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (reply.tool_calls?.[0]?.function.name !== "connection_check")
      throw new DomainError("AI_TOOLS_UNSUPPORTED", "模型未返回兼容的工具调用。");
    return {
      ok: true,
      message: "模型连接与工具调用检查通过。",
      durationMs: this.clock.now().getTime() - started,
    };
  }
  async create(identity: AuthenticatedIdentity, input: unknown): Promise<AiAnalysisJob> {
    const parsed = createAiAnalysisSchema.parse(input);
    const batch = await this.batches.getMetadata(
      parsed.batchId,
      projectIdsForPermission(identity, "run.read"),
    );
    if (!batch) throw new DomainError("BATCH_NOT_FOUND", "执行批次不存在。");
    assertAiPermission(identity, batch.projectId, true);
    const configuration = await this.repository.configuration();
    if (!configuration.configuration?.enabled)
      throw new DomainError("AI_DISABLED", "请先在模型配置中启用 AI 初析。");
    if (parsed.attemptId) {
      const source = await this.repository.source(parsed.attemptId);
      if (
        !source ||
        source.batch_id !== batch.id ||
        !["failed", "timed_out"].includes(String(source.outcome))
      )
        throw new DomainError("AI_ATTEMPT_INVALID", "请选择本批次已结束的失败或超时尝试。");
    } else if (!["succeeded", "failed", "cancelled"].includes(batch.status))
      throw new DomainError(
        "AI_BATCH_ACTIVE",
        "批次初析需要等待任务结束；已完成的失败用例可单独分析。",
      );
    const now = this.clock.now().toISOString();
    const created = await this.repository.create(
      {
        id: this.ids.next(),
        batchId: batch.id,
        projectId: batch.projectId,
        attemptId: parsed.attemptId ?? null,
        requestedBy: identity.user.id,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        total: 0,
        prepared: 0,
        completed: 0,
        failed: 0,
        reason: null,
        revision: 1,
      },
      parsed.requestKey,
    );
    if (
      created.attemptId !== (parsed.attemptId ?? null) ||
      created.requestedBy !== identity.user.id
    )
      throw new DomainError("IDEMPOTENCY_CONFLICT", "该请求标识已用于另一项初析请求。");
    return created;
  }
  async view(identity: AuthenticatedIdentity, input: Parameters<AiAnalysisRepository["view"]>[0]) {
    const batch = await this.batches.getMetadata(
      input.batchId,
      projectIdsForPermission(identity, "run.read"),
    );
    if (!batch) throw new DomainError("BATCH_NOT_FOUND", "执行批次不存在。");
    assertAiPermission(identity, batch.projectId);
    const key = JSON.stringify(input);
    if (this.cache) {
      try {
        const cached = await this.cache.get("ai-analysis-view", batch.projectId, 1, key);
        if (cached) return JSON.parse(cached) as Awaited<ReturnType<AiAnalysisRepository["view"]>>;
      } catch (error) {
        this.report(error);
      }
    }
    const view = await this.repository.view(input);
    if (this.cache) {
      try {
        await this.cache.set({
          namespace: "ai-analysis-view",
          tenantId: batch.projectId,
          schemaVersion: 1,
          key,
          value: JSON.stringify(view),
          ttlMs: 1000,
        });
      } catch (error) {
        this.report(error);
      }
    }
    return view;
  }
  async cancel(identity: AuthenticatedIdentity, batchId: string, jobId: string) {
    const view = await this.view(identity, { batchId, jobId, limit: 1 });
    if (!view) throw new DomainError("AI_JOB_NOT_FOUND", "初析记录不存在。");
    assertAiPermission(identity, view.job.projectId, true);
    await this.repository.cancel(jobId, this.clock.now().toISOString());
  }
}

/** Re-resolve current roles, including disabled accounts, before every disclosure and publication. */
export async function resolveAiActor(
  repository: IdentityAccessRepository,
  userId: string,
): Promise<AuthenticatedIdentity | null> {
  const user = await repository.findUser(userId);
  if (!user || user.status !== "active") return null;
  const [roles, system, project] = await Promise.all([
    repository.listRoles(),
    repository.listSystemRoleBindings([userId]),
    repository.listUserProjectRoleBindings([userId]),
  ]);
  const active = new Map(
    roles.filter((role) => role.active).map((role) => [role.id, role.permissions]),
  );
  const projectPermissions: Record<string, Permission[]> = {};
  for (const binding of project)
    projectPermissions[binding.projectId] = [
      ...new Set([
        ...(projectPermissions[binding.projectId] ?? []),
        ...(active.get(binding.roleId) ?? []),
      ]),
    ];
  return {
    user,
    sessionId: "ai-background",
    systemPermissions: [...new Set(system.flatMap((binding) => active.get(binding.roleId) ?? []))],
    projectPermissions,
  };
}
