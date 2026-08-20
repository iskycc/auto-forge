import { describe, expect, it } from "vitest";

import { RunnerInstallationProfileService } from "../src/manage-runner-installation-profiles";
import type {
  RunnerInstallationProfileRecord,
  RunnerInstallationProfileRepository,
  SecretCipherPort,
} from "../src/ports";

describe("RunnerInstallationProfileService", () => {
  it("stores the whole SSH connection as ciphertext and returns only a safe summary", async () => {
    const repository = new MemoryProfileRepository();
    const service = new RunnerInstallationProfileService(
      repository,
      reverseCipher,
      { now: () => new Date("2026-08-20T00:00:00.000Z") },
      { next: () => "profile-1" },
    );

    const summary = await service.save({
      runnerName: "runner-a",
      connection: {
        host: "10.20.30.40",
        port: 22,
        username: "automation",
        password: "Password!Runner123",
      },
      expectedHostKeySha256: `SHA256:${"A".repeat(43)}`,
      installationMode: "ubuntu",
      runAsRoot: false,
      caCertificatePem: "private-ca-material",
    });

    expect(summary).toMatchObject({
      id: "profile-1",
      host: "10.20.30.40",
      username: "automation",
      hasStoredPassword: true,
    });
    expect(summary).not.toHaveProperty("password");
    const stored = await repository.get("profile-1");
    expect(stored?.connectionEncrypted).not.toContain("10.20.30.40");
    expect(stored?.connectionEncrypted).not.toContain("Password!Runner123");
    await expect(service.connectionByProfileId("profile-1")).resolves.toMatchObject({
      connection: { password: "Password!Runner123" },
      caCertificatePem: "private-ca-material",
    });
  });
});

const reverseCipher: SecretCipherPort = {
  available: true,
  encrypt: (plaintext, purpose) => `${purpose}|${[...plaintext].reverse().join("")}`,
  decrypt: (ciphertext, purpose) => {
    const prefix = `${purpose}|`;
    if (!ciphertext.startsWith(prefix)) throw new Error("purpose mismatch");
    return [...ciphertext.slice(prefix.length)].reverse().join("");
  },
};

class MemoryProfileRepository implements RunnerInstallationProfileRepository {
  private readonly records = new Map<string, RunnerInstallationProfileRecord>();

  async list(limit: number): Promise<RunnerInstallationProfileRecord[]> {
    return [...this.records.values()].slice(0, limit);
  }

  async get(profileId: string): Promise<RunnerInstallationProfileRecord | null> {
    return this.records.get(profileId) ?? null;
  }

  async findByRunnerId(runnerId: string): Promise<RunnerInstallationProfileRecord | null> {
    return [...this.records.values()].find((record) => record.runnerId === runnerId) ?? null;
  }

  async findPendingByRunnerName(
    runnerName: string,
  ): Promise<RunnerInstallationProfileRecord | null> {
    return (
      [...this.records.values()].find(
        (record) => !record.runnerId && record.runnerName === runnerName,
      ) ?? null
    );
  }

  async upsert(record: RunnerInstallationProfileRecord): Promise<RunnerInstallationProfileRecord> {
    this.records.set(record.id, record);
    return record;
  }

  async bindPending(input: {
    runnerName: string;
    runnerId: string;
    updatedAt: string;
  }): Promise<void> {
    const record = await this.findPendingByRunnerName(input.runnerName);
    if (record) this.records.set(record.id, { ...record, runnerId: input.runnerId });
  }
}
