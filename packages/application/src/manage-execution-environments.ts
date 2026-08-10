import {
  createExecutionEnvironmentInputSchema,
  copyExecutionEnvironmentInputSchema,
  createExecutionSecretInputSchema,
  rotateExecutionSecretInputSchema,
  setExecutionEnvironmentStatusInputSchema,
  setExecutionSecretStatusInputSchema,
  updateExecutionEnvironmentInputSchema,
  type CreateExecutionEnvironmentInput,
  type CopyExecutionEnvironmentInput,
  type CreateExecutionSecretInput,
  type RotateExecutionSecretInput,
  type SetExecutionEnvironmentStatusInput,
  type SetExecutionSecretStatusInput,
  type UpdateExecutionEnvironmentInput,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import type {
  Clock,
  ExecutionEnvironmentRepository,
  ExecutionSecretRepository,
  IdGenerator,
  SecretCipherPort,
} from "./ports";

export class ExecutionEnvironmentService {
  constructor(
    private readonly environments: ExecutionEnvironmentRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: CreateExecutionEnvironmentInput, actorId: string) {
    const validated = createExecutionEnvironmentInputSchema.parse(input);
    const recordedAt = this.clock.now().toISOString();
    return this.environments.create({
      id: this.ids.next(),
      versionId: this.ids.next(),
      projectId: validated.projectId,
      name: validated.name,
      normalizedName: normalizeEnvironmentName(validated.name),
      description: validated.description,
      variables: sortVariables(validated.variables),
      secretBindings: sortVariables(validated.secretBindings),
      actorId,
      recordedAt,
    });
  }

  list(projectIds?: readonly string[]) {
    return this.environments.list(projectIds);
  }

  async get(environmentId: string, projectIds?: readonly string[]) {
    const environment = await this.environments.get(environmentId, projectIds);
    if (!environment) {
      throw new DomainError("EXECUTION_ENVIRONMENT_NOT_FOUND", "指定的执行环境不存在。");
    }
    return environment;
  }

  async update(environmentId: string, input: UpdateExecutionEnvironmentInput, actorId: string) {
    const validated = updateExecutionEnvironmentInputSchema.parse(input);
    return this.environments.update({
      environmentId,
      expectedRevision: validated.expectedRevision,
      actorId,
      recordedAt: this.clock.now().toISOString(),
      ...(validated.name
        ? {
            name: validated.name,
            normalizedName: normalizeEnvironmentName(validated.name),
          }
        : {}),
      ...(validated.description !== undefined ? { description: validated.description } : {}),
      ...(validated.variables || validated.secretBindings
        ? {
            nextVersion: {
              id: this.ids.next(),
              ...(validated.variables ? { variables: sortVariables(validated.variables) } : {}),
              ...(validated.secretBindings
                ? { secretBindings: sortVariables(validated.secretBindings) }
                : {}),
            },
          }
        : {}),
    });
  }

  async copy(
    environmentId: string,
    input: CopyExecutionEnvironmentInput,
    actorId: string,
    projectIds?: readonly string[],
  ) {
    const source = await this.get(environmentId, projectIds);
    const validated = copyExecutionEnvironmentInputSchema.parse(input);
    const recordedAt = this.clock.now().toISOString();
    return this.environments.create({
      id: this.ids.next(),
      versionId: this.ids.next(),
      projectId: source.projectId,
      name: validated.name,
      normalizedName: normalizeEnvironmentName(validated.name),
      description: validated.description ?? source.description,
      variables: source.current.variables.map((entry) => ({ ...entry })),
      secretBindings: source.current.secretBindings.map((entry) => ({ ...entry })),
      actorId,
      recordedAt,
    });
  }

  async listVersions(environmentId: string, projectIds?: readonly string[]) {
    await this.get(environmentId, projectIds);
    return this.environments.listVersions(environmentId, projectIds);
  }

  async listReferences(environmentId: string, projectIds?: readonly string[], limit = 100) {
    await this.get(environmentId, projectIds);
    return this.environments.listReferences(environmentId, projectIds, limit);
  }

  async setStatus(environmentId: string, input: SetExecutionEnvironmentStatusInput) {
    const validated = setExecutionEnvironmentStatusInputSchema.parse(input);
    return this.environments.setStatus({
      environmentId,
      expectedRevision: validated.expectedRevision,
      status: validated.status,
      recordedAt: this.clock.now().toISOString(),
    });
  }

  async resolveVersion(versionId: string, projectId: string) {
    const resolved = await this.environments.getVersion(versionId, projectId);
    if (!resolved) {
      throw new DomainError(
        "EXECUTION_ENVIRONMENT_VERSION_NOT_FOUND",
        "指定的执行环境版本不存在。",
      );
    }
    if (resolved.environment.status !== "active") {
      throw new DomainError("EXECUTION_ENVIRONMENT_DISABLED", "已停用的执行环境不能创建新批次。");
    }
    await this.environments.assertSecretsAvailableForExecution(
      projectId,
      resolved.version.secretBindings,
    );
    return resolved;
  }
}

export class ExecutionSecretService {
  constructor(
    private readonly secrets: ExecutionSecretRepository,
    private readonly cipher: SecretCipherPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: CreateExecutionSecretInput, actorId: string) {
    const validated = createExecutionSecretInputSchema.parse(input);
    this.assertCipherAvailable();
    const recordedAt = this.clock.now().toISOString();
    const secretId = this.ids.next();
    const versionId = this.ids.next();
    return this.secrets.create({
      id: secretId,
      versionId,
      projectId: validated.projectId,
      name: validated.name,
      normalizedName: normalizeEnvironmentName(validated.name),
      description: validated.description,
      valueEncrypted: this.cipher.encrypt(validated.value, executionSecretPurpose(versionId)),
      actorId,
      recordedAt,
    });
  }

  list(projectIds?: readonly string[]) {
    return this.secrets.list(projectIds);
  }

  async get(secretId: string, projectIds?: readonly string[]) {
    const secret = await this.secrets.get(secretId, projectIds);
    if (!secret) throw new DomainError("EXECUTION_SECRET_NOT_FOUND", "指定的执行密文不存在。");
    return secret;
  }

  async rotate(secretId: string, input: RotateExecutionSecretInput, actorId: string) {
    const validated = rotateExecutionSecretInputSchema.parse(input);
    this.assertCipherAvailable();
    const versionId = this.ids.next();
    return this.secrets.rotate({
      secretId,
      versionId,
      expectedRevision: validated.expectedRevision,
      valueEncrypted: this.cipher.encrypt(validated.value, executionSecretPurpose(versionId)),
      actorId,
      recordedAt: this.clock.now().toISOString(),
    });
  }

  async setStatus(secretId: string, input: SetExecutionSecretStatusInput) {
    const validated = setExecutionSecretStatusInputSchema.parse(input);
    return this.secrets.setStatus({
      secretId,
      expectedRevision: validated.expectedRevision,
      status: validated.status,
      recordedAt: this.clock.now().toISOString(),
    });
  }

  private assertCipherAvailable(): void {
    if (!this.cipher.available) {
      throw new DomainError("SECRET_CIPHER_UNAVAILABLE", "服务端未配置密文主密钥。");
    }
  }
}

function normalizeEnvironmentName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US");
}

function sortVariables<T extends { name: string }>(variables: readonly T[]): T[] {
  return [...variables].sort((left, right) => left.name.localeCompare(right.name));
}

export function executionSecretPurpose(versionId: string): string {
  return `execution-secret:${versionId}`;
}
