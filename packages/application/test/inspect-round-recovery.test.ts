import { describe, expect, it, vi } from "vitest";

import { defaultCaseSuiteExecutionPolicy, type CaseSuite } from "@autoforge/domain";

import { RoundRecoveryConfigurationInspector } from "../src/inspect-round-recovery";
import type {
  CaseSuiteRepository,
  JenkinsRoundRecoveryTransport,
  SecretCipherPort,
} from "../src/ports";

describe("RoundRecoveryConfigurationInspector", () => {
  it("uses an unsaved credential for a read-only Jenkins inspection", async () => {
    const transport = transportFake();
    const inspector = new RoundRecoveryConfigurationInspector({} as CaseSuiteRepository, transport);

    await expect(
      inspector.inspect(suite(), {
        ruleId: "recovery-1",
        jenkinsJobUrl: "https://jenkins.internal/job/reset/",
        apiKey: "jenkins-user:api-token",
      }),
    ).resolves.toMatchObject({ name: "reset", buildable: true });

    expect(transport.inspectJob).toHaveBeenCalledWith({
      jobUrl: "https://jenkins.internal/job/reset/",
      credential: "jenkins-user:api-token",
    });
    expect(transport.rebuildLast).not.toHaveBeenCalled();
  });

  it("decrypts an existing rule credential without exposing it in the result", async () => {
    const suites = {
      getRoundRecoveryCredentials: vi.fn().mockResolvedValue({
        "recovery-1": "encrypted-api-token",
      }),
    } as unknown as CaseSuiteRepository;
    const cipher = {
      available: true,
      encrypt: vi.fn(),
      decrypt: vi.fn().mockReturnValue("jenkins-user:stored-token"),
    } as SecretCipherPort;
    const transport = transportFake();
    const inspector = new RoundRecoveryConfigurationInspector(suites, transport, cipher);

    const result = await inspector.inspect(suite(), {
      ruleId: "recovery-1",
      jenkinsJobUrl: "https://jenkins.internal/job/reset/",
    });

    expect(cipher.decrypt).toHaveBeenCalledWith(
      "encrypted-api-token",
      "case-suite-round-recovery:suite-1:recovery-1",
    );
    expect(JSON.stringify(result)).not.toContain("stored-token");
    expect(transport.rebuildLast).not.toHaveBeenCalled();
  });

  it("does not send a stored credential to an edited job URL", async () => {
    const suites = {
      getRoundRecoveryCredentials: vi.fn(),
    } as unknown as CaseSuiteRepository;
    const transport = transportFake();
    const inspector = new RoundRecoveryConfigurationInspector(suites, transport, {
      available: true,
      encrypt: vi.fn(),
      decrypt: vi.fn(),
    });

    await expect(
      inspector.inspect(suite(), {
        ruleId: "recovery-1",
        jenkinsJobUrl: "https://attacker.invalid/job/capture/",
      }),
    ).rejects.toMatchObject({ code: "JENKINS_CREDENTIAL_REQUIRED" });

    expect(suites.getRoundRecoveryCredentials).not.toHaveBeenCalled();
    expect(transport.inspectJob).not.toHaveBeenCalled();
  });
});

function suite(): CaseSuite {
  return {
    id: "suite-1",
    projectId: "project-1",
    name: "Smoke",
    version: 1,
    revision: 1,
    status: "active",
    enabled: true,
    policy: {
      ...defaultCaseSuiteExecutionPolicy,
      roundRecoveryRules: [
        {
          id: "recovery-1",
          afterRound: 1,
          jenkinsJobUrl: "https://jenkins.internal/job/reset/",
          waitMinutes: 5,
          apiKeyConfigured: true,
        },
      ],
    },
    caseCount: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function transportFake(): JenkinsRoundRecoveryTransport {
  return {
    inspectJob: vi.fn().mockResolvedValue({
      name: "reset",
      url: "https://jenkins.internal/job/reset/",
      buildable: true,
      inQueue: false,
      lastBuild: {
        number: 41,
        url: "https://jenkins.internal/job/reset/41/",
        building: false,
        result: "SUCCESS",
      },
    }),
    rebuildLast: vi.fn(),
    inspectRebuild: vi.fn(),
  };
}
