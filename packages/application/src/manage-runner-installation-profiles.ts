import {
  runnerHostConnectionSchema,
  type RunnerHostConnection,
  type RunnerInstallationProfile,
} from "@autoforge/contracts";
import { DomainError, type Runner } from "@autoforge/domain";

import type {
  Clock,
  IdGenerator,
  RunnerInstallationProfileRecord,
  RunnerInstallationProfileRepository,
  SecretCipherPort,
} from "./ports";

type SaveRunnerInstallationProfileInput = {
  runnerId?: string;
  runnerName: string;
  connection: RunnerHostConnection;
  expectedHostKeySha256: string;
  installationMode: RunnerInstallationProfileRecord["installationMode"];
  runAsRoot: boolean;
  dataDirectory?: string;
  caCertificatePem?: string;
};

export type StoredRunnerInstallationConnection = {
  profile: RunnerInstallationProfileRecord;
  connection: RunnerHostConnection;
  caCertificatePem?: string;
};

export class RunnerInstallationProfileService {
  constructor(
    private readonly profiles: RunnerInstallationProfileRepository,
    private readonly cipher: SecretCipherPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async save(input: SaveRunnerInstallationProfileInput): Promise<RunnerInstallationProfile> {
    this.requireCipher();
    const existing = input.runnerId
      ? await this.profiles.findByRunnerId(input.runnerId)
      : await this.profiles.findPendingByRunnerName(input.runnerName);
    const id = existing?.id ?? this.ids.next();
    const now = this.clock.now().toISOString();
    const record = await this.profiles.upsert({
      id,
      ...(input.runnerId ? { runnerId: input.runnerId } : {}),
      runnerName: input.runnerName,
      connectionEncrypted: this.cipher.encrypt(
        JSON.stringify({
          schemaVersion: 1,
          connection: runnerHostConnectionSchema.parse(input.connection),
          ...(input.caCertificatePem ? { caCertificatePem: input.caCertificatePem } : {}),
        }),
        profilePurpose(id),
      ),
      expectedHostKeySha256: input.expectedHostKeySha256,
      installationMode: input.installationMode,
      runAsRoot: input.runAsRoot,
      ...(input.dataDirectory ? { dataDirectory: input.dataDirectory } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return this.summary(record, input.connection);
  }

  async list(): Promise<RunnerInstallationProfile[]> {
    this.requireCipher();
    const records = await this.profiles.list(500);
    return records.map((record) => this.summary(record, this.decrypt(record).connection));
  }

  async connectionForRunner(runnerId: string): Promise<StoredRunnerInstallationConnection | null> {
    this.requireCipher();
    const profile = await this.profiles.findByRunnerId(runnerId);
    return profile ? { profile, ...this.decrypt(profile) } : null;
  }

  async connectionByProfileId(profileId: string): Promise<StoredRunnerInstallationConnection> {
    this.requireCipher();
    const profile = await this.profiles.get(profileId);
    if (!profile) {
      throw new DomainError(
        "RUNNER_INSTALLATION_PROFILE_NOT_FOUND",
        "执行机没有可用的已保存连接信息。",
      );
    }
    return { profile, ...this.decrypt(profile) };
  }

  async bindRegisteredRunner(runnerName: string, runnerId: string): Promise<void> {
    await this.profiles.bindPending({
      runnerName,
      runnerId,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async reconcileBindings(runners: readonly Runner[]): Promise<void> {
    for (const runner of runners) {
      if (await this.profiles.findByRunnerId(runner.id)) continue;
      await this.bindRegisteredRunner(runner.name, runner.id);
    }
  }

  private decrypt(record: RunnerInstallationProfileRecord): {
    connection: RunnerHostConnection;
    caCertificatePem?: string;
  } {
    const payload = JSON.parse(
      this.cipher.decrypt(record.connectionEncrypted, profilePurpose(record.id)),
    ) as { schemaVersion?: unknown; connection?: unknown; caCertificatePem?: unknown };
    if (payload.schemaVersion !== 1) {
      throw new DomainError("SECRET_CIPHERTEXT_INVALID", "执行机连接密文版本无效。");
    }
    return {
      connection: runnerHostConnectionSchema.parse(payload.connection),
      ...(typeof payload.caCertificatePem === "string"
        ? { caCertificatePem: payload.caCertificatePem }
        : {}),
    };
  }

  private summary(
    record: RunnerInstallationProfileRecord,
    connection: RunnerHostConnection,
  ): RunnerInstallationProfile {
    return {
      id: record.id,
      ...(record.runnerId ? { runnerId: record.runnerId } : {}),
      runnerName: record.runnerName,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      expectedHostKeySha256: record.expectedHostKeySha256,
      installationMode: record.installationMode,
      runAsRoot: record.runAsRoot,
      ...(record.dataDirectory ? { dataDirectory: record.dataDirectory } : {}),
      hasStoredPassword: true,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private requireCipher(): void {
    if (!this.cipher.available) {
      throw new DomainError(
        "SECRET_CIPHER_UNAVAILABLE",
        "保存执行机连接信息前必须配置 AutoForge 主密钥。",
      );
    }
  }
}

function profilePurpose(profileId: string): string {
  return `runner-installation-profile:${profileId}`;
}
