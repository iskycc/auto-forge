import { describe, expect, it } from "vitest";
import {
  canReuseRecoveryCredential,
  recoveryInspectionCredential,
  type RecoveryCredentialDraft,
} from "./round-recovery-credential-input";

const draft = (id: string): RecoveryCredentialDraft => ({
  id,
  jenkinsJobUrl: "https://jenkins.internal/job/reset/",
  apiKey: "",
  apiKeyConfigured: false,
});
describe("recovery credential drafts", () => {
  it("tests with an unsaved local key and with a saved source reference without showing secrets", () => {
    const source = { ...draft("source"), apiKey: "user:token" };
    const target = {
      ...draft("target"),
      apiKeySource: { suiteId: "suite", ruleId: "source", label: "本任务 · 步骤 1" },
    };
    expect(recoveryInspectionCredential(target, [target, source], "suite")).toEqual({
      apiKey: "user:token",
    });
    expect(
      recoveryInspectionCredential(
        target,
        [target, { ...source, apiKey: "", apiKeyConfigured: true }],
        "suite",
      ),
    ).toEqual({ apiKeySource: { suiteId: "suite", ruleId: "source" } });
    const external = {
      ...target,
      apiKeySource: { suiteId: "other", ruleId: "source", label: "来源任务" },
    };
    expect(recoveryInspectionCredential(external, [external], "suite")).toEqual({
      apiKeySource: { suiteId: "other", ruleId: "source" },
    });
  });
  it("does not offer unconfigured steps, itself or chains that point back to the target", () => {
    const target = { ...draft("target"), apiKey: "user:token" };
    const cyclic = {
      ...draft("cyclic"),
      apiKeySource: { suiteId: "suite", ruleId: "target", label: "target" },
    };
    for (const source of [target, cyclic, draft("empty")])
      expect(canReuseRecoveryCredential(source, [target, cyclic], "suite", "target")).toBe(false);
    expect(
      canReuseRecoveryCredential(
        { ...draft("ready"), apiKeyConfigured: true },
        [],
        "suite",
        "target",
      ),
    ).toBe(true);
  });
  it("rejects a deleted local source and prevents sending an unsaved key to another server", () => {
    const target = {
      ...draft("target"),
      apiKeySource: { suiteId: "suite", ruleId: "source", label: "source" },
    };
    expect(() => recoveryInspectionCredential(target, [target], "suite")).toThrow("已删除");
    const source = {
      ...draft("source"),
      apiKey: "user:token",
      jenkinsJobUrl: "https://other.internal/job/reset/",
    };
    expect(() => recoveryInspectionCredential(target, [target, source], "suite")).toThrow(
      "同一 Jenkins",
    );
  });
});
