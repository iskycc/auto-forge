import { describe, expect, it, vi } from "vitest";
import {
  caseDebugDraftKey,
  createCaseDebugDraftStore,
  type CaseDebugDraft,
} from "./case-debug-draft";
import { DEFAULT_EXECUTION_ADAPTER_ENABLED } from "./case-suite-adapter-defaults";

const scope = {
  userId: "user",
  projectId: "project",
  projectVersionId: "version",
  testStageId: "stage",
  kind: "testng" as const,
};
const defaults: CaseDebugDraft = {
  runnerKind: "runner",
  runnerId: "",
  groupId: "",
  adapterEnabled: DEFAULT_EXECUTION_ADAPTER_ENABLED,
  suiteName: "Project",
  testName: "V1 SIT",
  addresses: "",
};

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const create = (key = caseDebugDraftKey(scope)) =>
    createCaseDebugDraftStore(key, defaults, () => storage);
  return { values, storage, create };
}

describe("case debug automatic configuration saving", () => {
  it("restores edits without executing, including empty text, choices and inactive resource selection", () => {
    const { create, values } = fixture();
    const store = create();
    const unsubscribe = store.subscribe(vi.fn());
    store.update({
      executionClass: { id: "class", label: "com.example.Payment" },
      runnerId: "runner",
      suiteName: "",
    });
    store.update({
      runnerKind: "group",
      groupId: "group",
      addresses: "10.0.0.1\n10.0.0.2",
      adapterEnabled: false,
    });
    unsubscribe();
    const beforeMount = [...values];
    const restored = create();
    expect(restored.getServerSnapshot().draft).toEqual(defaults);
    expect([...values]).toEqual(beforeMount);
    restored.subscribe(vi.fn());
    expect(restored.getSnapshot()).toEqual(store.getSnapshot());
    expect(restored.getSnapshot().draft).toMatchObject({
      suiteName: "",
      runnerId: "runner",
      groupId: "group",
      adapterEnabled: false,
    });
    expect([...values]).toEqual(beforeMount);
  });

  it("isolates each user, project, version, stage and debug type", () => {
    const { create } = fixture();
    const original = create();
    original.subscribe(vi.fn());
    original.update({ addresses: "personal-environment" });
    for (const changed of [
      { userId: "other" },
      { projectId: "other" },
      { projectVersionId: "other" },
      { testStageId: "other" },
      { kind: "ddt" as const },
    ]) {
      const next = create(caseDebugDraftKey({ ...scope, ...changed }));
      next.subscribe(vi.fn());
      expect(next.getSnapshot().draft).toEqual(defaults);
    }
  });

  it("retains current edits when browser storage is blocked and reports the save failure", () => {
    const store = createCaseDebugDraftStore(caseDebugDraftKey(scope), defaults, () => {
      throw new Error("Storage blocked");
    });
    store.subscribe(vi.fn());
    store.update({ suiteName: "Still usable" });
    expect(store.getSnapshot()).toMatchObject({
      status: "unavailable",
      draft: { suiteName: "Still usable" },
    });
  });

  it("recovers malformed or oversized stored drafts without overwriting them during mount", () => {
    const { create, values } = fixture();
    for (const invalid of ["{", JSON.stringify({ schemaVersion: 999 }), "x".repeat(65_537)]) {
      values.set(caseDebugDraftKey(scope), invalid);
      const store = create();
      store.subscribe(vi.fn());
      expect(store.getSnapshot()).toMatchObject({ status: "invalid", draft: defaults });
      expect(values.get(caseDebugDraftKey(scope))).toBe(invalid);
      store.update({ testName: "Recovered" });
      expect(store.getSnapshot().status).toBe("saved");
    }
  });

  it("persists only configuration fields and never personal case contents or API access keys", () => {
    const { create, values } = fixture();
    const store = create();
    store.subscribe(vi.fn());
    const choice = {
      id: "PAY-1",
      label: "PAY-1",
      suggestedClass: { id: "class", label: "Payment" },
      data: { password: "private" },
      accessKey: "secret",
    };
    store.update({ ddtCase: choice });
    const stored = values.get(caseDebugDraftKey(scope))!;
    expect(stored).toContain("PAY-1");
    expect(stored).not.toMatch(/private|secret|accessKey|password/);
    const restored = create();
    restored.subscribe(vi.fn());
    expect(restored.getSnapshot().draft.ddtCase).toEqual({ id: "PAY-1", label: "PAY-1" });
  });

  it("does not replace a recoverable draft with an oversized edit and resumes saving after correction", () => {
    const { create, values } = fixture();
    const store = create();
    store.subscribe(vi.fn());
    store.update({ addresses: "127.0.0.1" });
    const previous = [...values];
    store.update({ addresses: "\u0000".repeat(32_768) });
    expect(store.getSnapshot().status).toBe("unavailable");
    expect([...values]).toEqual(previous);
    store.update({ addresses: "127.0.0.2" });
    expect(store.getSnapshot().status).toBe("saved");
    const restored = create();
    restored.subscribe(vi.fn());
    expect(restored.getSnapshot().draft.addresses).toBe("127.0.0.2");
  });
});
