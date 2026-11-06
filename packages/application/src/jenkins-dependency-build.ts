import {
  isJenkinsDependencyBuildActive,
  jenkinsDependencyConnectionSchema,
  saveJenkinsDependencyConfigurationSchema,
  triggerJenkinsDependencyBuildSchema,
  type JenkinsDependencyConnection,
  type JenkinsDependencyBuild,
  type JenkinsDependencyView,
  type SaveJenkinsDependencyConfiguration,
  type TriggerJenkinsDependencyBuild,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import type { Clock, SecretCipherPort } from "./ports";
import type {
  JenkinsDependencyRecord,
  JenkinsDependencyRepository,
  JenkinsDependencyTransport,
} from "./jenkins-dependency-build-ports";

export class JenkinsDependencyBuildService {
  constructor(
    private readonly repository: JenkinsDependencyRepository,
    private readonly transport: JenkinsDependencyTransport,
    private readonly cipher: SecretCipherPort,
    private readonly clock: Clock,
  ) {}

  async read(
    projectId: string,
    versionId: string,
    refresh = false,
  ): Promise<JenkinsDependencyView> {
    await this.assertVersion(projectId, versionId);
    let record = await this.repository.read(versionId);
    if (record?.build && refresh) {
      const build = record.build;
      if (
        build.status === "submitting" &&
        this.clock.now().getTime() - Date.parse(build.triggeredAt) > 30_000
      ) {
        await this.repository.updateBuild(versionId, record.buildRevision, {
          ...build,
          status: "unknown",
          message: uncertainSubmissionMessage,
        });
      } else if (build.status === "queued" || build.status === "running") {
        let update: Awaited<ReturnType<JenkinsDependencyTransport["poll"]>>;
        try {
          update = await this.transport.poll(this.connection(record), build);
        } catch (cause) {
          throw new DomainError(
            "JENKINS_STATUS_UNAVAILABLE",
            "暂时无法读取 Jenkins 状态，已保留构建记录，可点击刷新重试。",
            { cause },
          );
        }
        await this.repository.updateBuild(versionId, record.buildRevision, { ...build, ...update });
      }
      record = await this.repository.read(versionId);
    }
    return this.view(record);
  }

  async save(projectId: string, versionId: string, draft: SaveJenkinsDependencyConfiguration) {
    await this.assertVersion(projectId, versionId, true);
    const input = saveJenkinsDependencyConfigurationSchema.parse(draft);
    const current = await this.repository.read(versionId);
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new DomainError(
        "JENKINS_CONFIGURATION_REVISION_CONFLICT",
        "Jenkins 流水线配置已更新，当前输入已过期。",
      );
    this.assertInactive(current);
    const previous = current ? this.connection(current) : undefined;
    const jobUrl = normalizedJobUrl(input.jobUrl);
    if (
      !input.apiToken &&
      (!previous || previous.jobUrl !== jobUrl || previous.username !== input.username)
    )
      throw new DomainError(
        "JENKINS_CREDENTIAL_REQUIRED",
        "首次配置或修改 Jenkins 地址／用户名后，请重新填写 API 密钥。",
      );
    const connection = jenkinsDependencyConnectionSchema.parse({
      jobUrl,
      username: input.username,
      parameters: input.parameters,
      apiToken: input.apiToken ?? previous?.apiToken,
    });
    const saved = await this.repository.save({
      projectId,
      versionId,
      expectedRevision: input.expectedRevision,
      connectionCiphertext: this.cipher.encrypt(
        JSON.stringify(connection),
        secretPurpose(versionId),
      ),
      updatedAt: this.clock.now().toISOString(),
    });
    if (!saved) throw conflict();
    return this.read(projectId, versionId);
  }

  async inspect(projectId: string, versionId: string) {
    await this.assertVersion(projectId, versionId);
    const record = await this.requiredRecord(versionId);
    try {
      return await this.transport.inspect(this.connection(record));
    } catch (cause) {
      throw new DomainError(
        "JENKINS_CONFIGURATION_TEST_FAILED",
        safeTransportMessage(cause, "Jenkins 连接失败，请检查地址、账号权限和 API 密钥。"),
        { cause },
      );
    }
  }

  async trigger(
    projectId: string,
    versionId: string,
    draft: TriggerJenkinsDependencyBuild,
    actorName: string,
  ) {
    await this.assertVersion(projectId, versionId, true);
    const input = triggerJenkinsDependencyBuildSchema.parse(draft);
    const record = await this.requiredRecord(versionId);
    if (record.build?.id === input.requestId) return this.view(record);
    this.assertInactive(record);
    const connection = this.connection(record);
    const build = {
      id: input.requestId,
      status: "submitting" as const,
      jobUrl: connection.jobUrl,
      triggeredBy: actorName,
      triggeredAt: this.clock.now().toISOString(),
    };
    if (
      !(await this.repository.claim({
        versionId,
        expectedRevision: input.expectedRevision,
        expectedBuildRevision: input.expectedBuildRevision,
        build,
      }))
    )
      throw conflict();
    let submitted: JenkinsDependencyBuild;
    try {
      const queued = await this.transport.trigger(connection);
      submitted = { ...build, status: "queued", queueUrl: queued.queueUrl };
    } catch (cause) {
      // A failed POST response may follow a successful remote enqueue. Never repeat it automatically.
      const rejected = cause instanceof DomainError && cause.code === "JENKINS_BUILD_REJECTED";
      submitted = {
        ...build,
        status: rejected ? "failed" : "unknown",
        message: rejected ? cause.message : uncertainSubmissionMessage,
      };
    }
    await this.repository.updateBuild(versionId, record.buildRevision + 1, submitted);
    return this.read(projectId, versionId);
  }

  async acknowledge(projectId: string, versionId: string, buildRevision: number) {
    await this.assertVersion(projectId, versionId, true);
    const record = await this.requiredRecord(versionId);
    if (
      record.build?.status !== "unknown" ||
      !(await this.repository.updateBuild(versionId, buildRevision, {
        ...record.build,
        status: "closed",
        message: "已人工核对 Jenkins；本次提交的最终结果以 Jenkins 为准。",
      }))
    )
      throw conflict();
    return this.read(projectId, versionId);
  }

  private async assertVersion(projectId: string, versionId: string, mutable = false) {
    const status = await this.repository.versionStatus(projectId, versionId);
    if (!status) throw new DomainError("PROJECT_VERSION_NOT_FOUND", "指定的项目版本不存在。");
    if (mutable && status === "archived")
      throw new DomainError("PROJECT_VERSION_ARCHIVED", "已归档的项目版本不能修改配置或触发构建。");
  }
  private async requiredRecord(versionId: string) {
    const record = await this.repository.read(versionId);
    if (!record)
      throw new DomainError(
        "JENKINS_CONFIGURATION_REQUIRED",
        "请先保存当前版本的 Jenkins 流水线配置。",
      );
    return record;
  }
  private assertInactive(record: JenkinsDependencyRecord | null) {
    if (record?.build && isJenkinsDependencyBuildActive(record.build.status)) throw conflict();
  }
  private connection(record: JenkinsDependencyRecord): JenkinsDependencyConnection {
    return jenkinsDependencyConnectionSchema.parse(
      JSON.parse(this.cipher.decrypt(record.connectionCiphertext, secretPurpose(record.versionId))),
    );
  }
  private view(record: JenkinsDependencyRecord | null): JenkinsDependencyView {
    if (!record) return { revision: 0, buildRevision: 0 };
    const connection = this.connection(record);
    const configuration = {
      jobUrl: connection.jobUrl,
      username: connection.username,
      parameters: connection.parameters,
    };
    return {
      revision: record.revision,
      buildRevision: record.buildRevision,
      configuration: { ...configuration, apiTokenConfigured: true },
      ...(record.build ? { build: record.build } : {}),
    };
  }
}
const uncertainSubmissionMessage =
  "无法确认 Jenkins 是否已接收构建，请先打开 Jenkins 核对，确认后再解除提交保护；平台不会自动重复提交。";
function secretPurpose(versionId: string) {
  return `jenkins-dependency:${versionId}`;
}
function normalizedJobUrl(value: string) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}
function conflict() {
  return new DomainError(
    "JENKINS_BUILD_CONFLICT",
    "当前版本已有构建在执行、提交结果待核对或配置已更新，请刷新后操作。",
  );
}
function safeTransportMessage(cause: unknown, fallback: string): string {
  return cause instanceof DomainError && cause.code.startsWith("JENKINS_")
    ? cause.message
    : fallback;
}
