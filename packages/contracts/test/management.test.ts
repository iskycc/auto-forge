import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUNNER_DATA_DIRECTORY,
  installRunnerAgentRequestSchema,
  installRunnerAgentInputSchema,
  inspectRoundRecoveryConfigurationInputSchema,
  runnerRegistrationResultSchema,
  runnerHeartbeatInputSchema,
  runnerHeartbeatResultSchema,
  probeRunnerHostRequestSchema,
  updateRunnerAgentInputSchema,
  caseSuiteExecutionPolicySchema,
  updateCaseSuiteItemsInputSchema,
  createWebhookConfigurationInputSchema,
} from "../src/management";

describe("Runner registration contracts", () => {
  it("accepts the optional startup terminal ticket without changing protocol v1", () => {
    expect(
      runnerRegistrationResultSchema.parse({
        schemaVersion: 1,
        runnerId: "runner-1",
        credential: "runner-credential-with-more-than-32-bytes",
        heartbeatIntervalSeconds: 15,
        terminalConnectionToken: "short-lived-terminal-ticket",
      }),
    ).toMatchObject({ terminalConnectionToken: "short-lived-terminal-ticket" });
  });
});

describe("webhook configuration contracts", () => {
  it("accepts GET endpoints and POST JSON templates with documented variables", () => {
    expect(
      createWebhookConfigurationInputSchema.parse({
        projectId: "project-1",
        name: "内部通知",
        targetUrl: "http://quality-gateway.internal/autoforge",
        method: "GET",
      }),
    ).toMatchObject({ method: "GET", enabled: true });
    expect(
      createWebhookConfigurationInputSchema.parse({
        projectId: "project-1",
        name: "质量机器人",
        targetUrl: "https://hooks.example.test/quality",
        method: "POST",
        bodyTemplate: '{"batch":"{{batch.id}}","failed":"{{summary.failed}}"}',
      }),
    ).toMatchObject({ method: "POST" });
  });

  it("rejects credentials, non-HTTP targets, invalid JSON and unknown variables", () => {
    for (const input of [
      { targetUrl: "file:///tmp/result", bodyTemplate: '{"batch":"{{batch.id}}"}' },
      {
        targetUrl: "https://user:password@hooks.example.test/result",
        bodyTemplate: '{"batch":"{{batch.id}}"}',
      },
      { targetUrl: "https://hooks.example.test/result", bodyTemplate: "not-json" },
      {
        targetUrl: "https://hooks.example.test/result",
        bodyTemplate: '{"batch":"{{unknown.value}}"}',
      },
    ]) {
      expect(() =>
        createWebhookConfigurationInputSchema.parse({
          projectId: "project-1",
          name: "错误配置",
          method: "POST",
          ...input,
        }),
      ).toThrow();
    }
  });
});

const connection = {
  host: "10.20.30.40",
  port: 22,
  username: "runner-admin",
  password: "correct-password",
};

describe("case suite execution policy", () => {
  it("accepts a read-only Jenkins recovery inspection request", () => {
    expect(
      inspectRoundRecoveryConfigurationInputSchema.parse({
        ruleId: "recovery-1",
        jenkinsJobUrl: "https://jenkins.internal/job/reset/",
        apiKey: "jenkins-user:api-token",
      }),
    ).toMatchObject({ ruleId: "recovery-1" });
  });

  it("rejects the retired task parameter template", () => {
    expect(() => caseSuiteExecutionPolicySchema.parse({ parameters: { REGION: "cn" } })).toThrow();
  });

  it("accepts ordered retry concurrency and Jenkins round recovery rules", () => {
    expect(
      caseSuiteExecutionPolicySchema.parse({
        retryMode: "round",
        retryConcurrencyRules: [
          {
            id: "rule-1",
            executionRound: 3,
            previousRoundPassRateMaximum: 20,
            remainingRunsMinimum: 50,
            concurrency: 10,
          },
        ],
        roundRecoveryRules: [
          {
            id: "recovery-1",
            afterRound: 1,
            jenkinsJobUrl: "https://jenkins.internal/job/reset-environment/",
            waitMinutes: 5,
            apiKey: "jenkins-user:api-token",
          },
        ],
      }),
    ).toMatchObject({ retryMode: "round" });
  });

  it("accepts multiple Jenkins recoveries at the same round boundary", () => {
    expect(
      caseSuiteExecutionPolicySchema.parse({
        retryMode: "round",
        roundRecoveryRules: [
          { id: "a", afterRound: 1, jenkinsJobUrl: "https://jenkins/job/a/", waitMinutes: 0 },
          { id: "b", afterRound: 1, jenkinsJobUrl: "https://jenkins/job/b/", waitMinutes: 5 },
        ],
      }).roundRecoveryRules,
    ).toHaveLength(2);
  });

  it("maps legacy ranges and rejects duplicate rule IDs and credentials in Jenkins URLs", () => {
    expect(
      caseSuiteExecutionPolicySchema.parse({
        retryConcurrencyRules: [
          { id: "rule", executionRoundFrom: 4, executionRoundTo: 6, concurrency: 10 },
        ],
      }).retryConcurrencyRules,
    ).toEqual([{ id: "rule", executionRound: 4, concurrency: 10 }]);
    expect(() =>
      caseSuiteExecutionPolicySchema.parse({
        roundRecoveryRules: [
          { id: "same", afterRound: 1, jenkinsJobUrl: "https://jenkins/job/a/", waitMinutes: 0 },
          { id: "same", afterRound: 2, jenkinsJobUrl: "https://jenkins/job/b/", waitMinutes: 0 },
        ],
      }),
    ).toThrow();
    expect(() =>
      caseSuiteExecutionPolicySchema.parse({
        roundRecoveryRules: [
          {
            id: "a",
            afterRound: 1,
            jenkinsJobUrl: "https://user:token@jenkins/job/a/",
            waitMinutes: 0,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("case suite item mutation contracts", () => {
  it("accepts one atomic 100,000-case task mutation", () => {
    const caseDefinitionIds = Array.from({ length: 100_000 }, (_, index) => `case-${index}`);

    expect(
      updateCaseSuiteItemsInputSchema.parse({ caseDefinitionIds }).caseDefinitionIds,
    ).toHaveLength(100_000);
  });

  it("keeps the HTTP mutation payload bounded above the required scale", () => {
    const caseDefinitionIds = Array.from({ length: 100_001 }, (_, index) => `case-${index}`);

    expect(() => updateCaseSuiteItemsInputSchema.parse({ caseDefinitionIds })).toThrow();
  });
});

const installInput = {
  connection,
  expectedHostKeySha256: `SHA256:${"a".repeat(43)}`,
  name: "runner-west-1",
};

describe("runner data directory contracts", () => {
  it("defaults to the standard directory when the field is omitted", () => {
    expect(DEFAULT_RUNNER_DATA_DIRECTORY).toBe("/var/lib/autoforge-agent");
    const parsed = installRunnerAgentInputSchema.parse(installInput);
    expect(parsed.dataDirectory).toBeUndefined();
  });

  it("accepts an absolute custom directory for install and update", () => {
    expect(
      installRunnerAgentInputSchema.parse({ ...installInput, dataDirectory: "/data/autoforge" })
        .dataDirectory,
    ).toBe("/data/autoforge");
    expect(
      updateRunnerAgentInputSchema.parse({
        connection,
        expectedHostKeySha256: `SHA256:${"a".repeat(43)}`,
        dataDirectory: "/mnt/large/runner",
      }).dataDirectory,
    ).toBe("/mnt/large/runner");
  });

  it("rejects relative paths, empty values, and traversal segments", () => {
    for (const invalid of ["", "relative/path", "/data/../etc", "/data/..", "//", "/a b/c"]) {
      expect(() =>
        installRunnerAgentInputSchema.parse({ ...installInput, dataDirectory: invalid }),
      ).toThrow();
    }
  });
});

describe("saved Runner installation contracts", () => {
  it("requires a fresh host-key confirmation and complete explicit configuration", () => {
    expect(
      installRunnerAgentRequestSchema.parse({
        profileId: "profile-1",
        expectedHostKeySha256: `SHA256:${"a".repeat(43)}`,
        name: "recovered-runner",
        labels: ["linux", "recovered"],
        maxConcurrency: 8,
        terminalEnabled: true,
        runAsRoot: false,
        installationMode: "auto",
        dataDirectory: "/data/autoforge",
      }),
    ).toMatchObject({ profileId: "profile-1", maxConcurrency: 8, terminalEnabled: true });
    expect(() =>
      installRunnerAgentRequestSchema.parse({
        profileId: "profile-1",
        name: "must-probe-first",
      }),
    ).toThrow();
  });

  it("allows probing with encrypted stored credentials", () => {
    expect(
      probeRunnerHostRequestSchema.parse({ profileId: "profile-1", installationMode: "ubuntu" }),
    ).toEqual({ profileId: "profile-1", installationMode: "ubuntu" });
  });
});

describe("runner heartbeat cache reconciliation contracts", () => {
  it("accepts bounded cached batch IDs and defaults the response list", () => {
    const input = runnerHeartbeatInputSchema.parse({
      schemaVersion: 1,
      busySlots: 0,
      labels: [],
      capabilities: [],
      maxConcurrency: 2,
      agentVersion: "0.2.0",
      terminalEnabled: false,
      cachedBatchIds: ["batch-1"],
    });
    expect(input.cachedBatchIds).toEqual(["batch-1"]);
    const result = runnerHeartbeatResultSchema.parse({
      schemaVersion: 1,
      acceptedAt: "2026-08-19T00:00:00.000Z",
      heartbeatIntervalSeconds: 15,
      draining: false,
    });
    expect(result.closedBatchIds).toEqual([]);
    expect(result.disabled).toBe(false);
  });

  it("rejects an unbounded cached batch list", () => {
    expect(() =>
      runnerHeartbeatInputSchema.parse({
        schemaVersion: 1,
        busySlots: 0,
        labels: [],
        capabilities: [],
        maxConcurrency: 2,
        agentVersion: "0.2.0",
        terminalEnabled: false,
        cachedBatchIds: Array.from({ length: 1_025 }, (_, index) => `batch-${index}`),
      }),
    ).toThrow();
  });
});
