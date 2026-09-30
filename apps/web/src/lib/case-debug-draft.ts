import { z } from "zod";

const choiceSchema = z.object({ id: z.string().min(1).max(512), label: z.string().max(2_048) });
const draftSchema = z.object({
  executionClass: choiceSchema.optional(),
  ddtCase: choiceSchema.optional(),
  runnerKind: z.enum(["runner", "group"]),
  runnerId: z.string().max(128),
  groupId: z.string().max(128),
  adapterEnabled: z.boolean(),
  suiteName: z.string().max(512),
  testName: z.string().max(512),
  addresses: z.string().max(32_768),
});
const storedDraftSchema = z.object({ schemaVersion: z.literal(1), draft: draftSchema });
const maximumStoredCharacters = 65_536;

export type CaseDebugDraft = z.infer<typeof draftSchema>;
type DraftSnapshot = {
  draft: CaseDebugDraft;
  status: "loading" | "ready" | "saved" | "invalid" | "unavailable";
};

export function caseDebugDraftKey(scope: {
  userId: string;
  projectId: string;
  projectVersionId: string;
  testStageId: string;
  kind: "testng" | "ddt";
}): string {
  return `autoforge.case-debug-draft.v1:${JSON.stringify([
    scope.userId,
    scope.projectId,
    scope.projectVersionId,
    scope.testStageId,
    scope.kind,
  ])}`;
}

/** Small browser drafts only: no case data, credentials, API keys or execution state. */
export function createCaseDebugDraftStore(
  key: string,
  defaults: CaseDebugDraft,
  storage: () => Pick<Storage, "getItem" | "setItem">,
) {
  const initial: DraftSnapshot = { draft: defaults, status: "loading" };
  let snapshot = initial;
  const listeners = new Set<() => void>();
  function publish(next: DraftSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function restore() {
    let raw: string | null;
    try {
      raw = storage().getItem(key);
    } catch {
      // Browser policies can forbid storage; keep the form usable and expose the failure.
      publish({ draft: defaults, status: "unavailable" });
      return;
    }
    if (raw === null) {
      publish({ draft: defaults, status: "ready" });
      return;
    }
    try {
      if (raw.length > maximumStoredCharacters) throw new Error("Oversized debug draft");
      const stored = storedDraftSchema.parse(JSON.parse(raw));
      publish({ draft: stored.draft, status: "saved" });
    } catch {
      // Do not overwrite corrupt or incompatible storage merely by opening the page.
      publish({ draft: defaults, status: "invalid" });
    }
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      // Restore after hydration, before enabling edits; mounting never writes defaults.
      if (snapshot.status === "loading") restore();
      return () => {
        listeners.delete(listener);
      };
    },
    update(changes: Partial<CaseDebugDraft>) {
      if (snapshot.status === "loading") return;
      const draft = { ...snapshot.draft, ...changes };
      let status: DraftSnapshot["status"] = "saved";
      try {
        const serialized = JSON.stringify(storedDraftSchema.parse({ schemaVersion: 1, draft }));
        if (serialized.length > maximumStoredCharacters) throw new Error("Oversized debug draft");
        storage().setItem(key, serialized);
      } catch {
        // The last edit remains in memory even if storage is full, blocked or out of bounds.
        status = "unavailable";
      }
      publish({ draft, status });
    },
  };
}
