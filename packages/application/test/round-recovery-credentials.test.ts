import { describe, expect, it, vi } from "vitest";
import { defaultCaseSuiteExecutionPolicy, type CaseSuite } from "@autoforge/domain";
import type { CaseSuiteRepository, SecretCipherPort } from "../src/ports";
import { RoundRecoveryCredentialResolver } from "../src/round-recovery-credentials";

const jobUrl = "https://jenkins.internal/job/reset/";
const rule = (id: string) => ({
  id,
  afterRound: 1,
  jenkinsJobUrl: jobUrl,
  waitMinutes: 0,
  apiKeyConfigured: true,
});
function suite(id: string, rules = [rule("stored")]): CaseSuite {
  return {
    id,
    name: id,
    projectId: "project",
    caseCount: 0,
    version: 1,
    revision: 1,
    status: "active",
    enabled: true,
    policy: { ...defaultCaseSuiteExecutionPolicy, roundRecoveryRules: rules },
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
  };
}
function fixture() {
  const repository = {
    getSummary: vi.fn().mockResolvedValue(suite("source")),
    getRoundRecoveryCredentials: vi
      .fn()
      .mockImplementation(async (_suiteId: string, ids: string[]) =>
        Object.fromEntries(
          ids.filter((id) => id === "stored").map((id) => [id, "encrypted-stored"]),
        ),
      ),
  };
  const cipher = {
    available: true,
    encrypt: vi.fn((_credential: string, purpose: string) => `encrypted:${purpose}`),
    decrypt: vi.fn(() => "user:stored-token"),
  };
  const resolver = new RoundRecoveryCredentialResolver(
    repository as unknown as CaseSuiteRepository,
    cipher as SecretCipherPort,
  );
  return { repository, cipher, resolver };
}

describe("Jenkins recovery credential reuse", () => {
  it("reuses an unsaved credential across multiple steps independently of their order", async () => {
    const { resolver, cipher } = fixture();
    const upserts = await resolver.prepare(suite("target", []), [
      { ...rule("third"), apiKeySource: { suiteId: "target", ruleId: "second" } },
      { ...rule("first"), apiKey: "user:new-token" },
      { ...rule("second"), apiKeySource: { suiteId: "target", ruleId: "first" } },
    ]);
    expect(Object.keys(upserts).sort()).toEqual(["first", "second", "third"]);
    for (const id of ["first", "second", "third"])
      expect(cipher.encrypt).toHaveBeenCalledWith(
        "user:new-token",
        `case-suite-round-recovery:target:${id}`,
      );
  });

  it("reuses a saved key in the same task and keeps unchanged credentials without requiring decryption", async () => {
    const { resolver, cipher } = fixture();
    await resolver.prepare(suite("target"), [
      rule("stored"),
      { ...rule("new"), apiKeySource: { suiteId: "target", ruleId: "stored" } },
    ]);
    expect(cipher.encrypt).toHaveBeenCalledTimes(1);
    expect(cipher.encrypt).toHaveBeenCalledWith(
      "user:stored-token",
      "case-suite-round-recovery:target:new",
    );
    const unchanged = new RoundRecoveryCredentialResolver(
      fixture().repository as unknown as CaseSuiteRepository,
    );
    expect(await unchanged.prepare(suite("target"), [rule("stored")])).toEqual({});
  });

  it("requires source management scope and re-encrypts another task's credential for the target", async () => {
    const { resolver, repository, cipher } = fixture();
    await resolver.prepare(
      suite("target", []),
      [{ ...rule("new"), apiKeySource: { suiteId: "source", ruleId: "stored" } }],
      ["project"],
    );
    expect(repository.getSummary).toHaveBeenCalledWith("source", ["project"]);
    expect(cipher.decrypt).toHaveBeenCalledWith(
      "encrypted-stored",
      "case-suite-round-recovery:source:stored",
    );
    expect(cipher.encrypt).toHaveBeenCalledWith(
      "user:stored-token",
      "case-suite-round-recovery:target:new",
    );
    repository.getSummary.mockResolvedValue(null);
    repository.getRoundRecoveryCredentials.mockClear();
    await expect(
      resolver.readSource({ suiteId: "source", ruleId: "stored" }, jobUrl, []),
    ).rejects.toMatchObject({ code: "CASE_SUITE_NOT_FOUND" });
    expect(repository.getRoundRecoveryCredentials).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "rejects self and multi-step credential cycles (self=%s)",
    async (self) => {
      const { resolver, cipher } = fixture();
      await expect(
        resolver.prepare(suite("target", []), [
          { ...rule("a"), apiKeySource: { suiteId: "target", ruleId: self ? "a" : "b" } },
          { ...rule("b"), apiKeySource: { suiteId: "target", ruleId: "a" } },
        ]),
      ).rejects.toMatchObject({ code: "JENKINS_CREDENTIAL_REFERENCE_CYCLE" });
      expect(cipher.encrypt).not.toHaveBeenCalled();
    },
  );

  it("rejects deleted sources, missing keys and cross-origin reuse before exposing a credential", async () => {
    const { resolver, repository, cipher } = fixture();
    await expect(
      resolver.readSource({ suiteId: "source", ruleId: "missing" }, jobUrl),
    ).rejects.toMatchObject({ code: "JENKINS_CREDENTIAL_REQUIRED" });
    await expect(
      resolver.readSource(
        { suiteId: "source", ruleId: "stored" },
        "https://other.internal/job/reset/",
      ),
    ).rejects.toMatchObject({ code: "JENKINS_CREDENTIAL_ORIGIN_MISMATCH" });
    expect(cipher.decrypt).not.toHaveBeenCalled();
    await expect(
      resolver.prepare(suite("target"), [
        { ...rule("new"), apiKeySource: { suiteId: "target", ruleId: "stored" } },
      ]),
    ).rejects.toMatchObject({ code: "JENKINS_CREDENTIAL_REQUIRED" });
    repository.getRoundRecoveryCredentials.mockResolvedValueOnce({});
    await expect(
      resolver.readSource({ suiteId: "source", ruleId: "stored" }, jobUrl),
    ).rejects.toMatchObject({ code: "JENKINS_CREDENTIAL_REQUIRED" });
  });
});
