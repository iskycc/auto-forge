"use client";

import { useSyncExternalStore } from "react";

// Only explicit browser edits populate this bounded, per-user page-session store.
const overrides = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
const MAXIMUM_DRAFT_TASKS = 128;
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function executionEnvironmentDraftKey(userId: string, suiteId: string): string {
  return JSON.stringify([userId, suiteId]);
}

export function readSuiteExecutionEnvironment(key: string): readonly string[] | undefined {
  return overrides.get(key);
}

export function setSuiteExecutionEnvironment(
  key: string,
  addresses: readonly string[] | undefined,
): void {
  if (addresses) {
    if (addresses.length > 128) throw new Error("环境 IP 最多 128 个。");
    if (!overrides.has(key) && overrides.size >= MAXIMUM_DRAFT_TASKS)
      overrides.delete(overrides.keys().next().value!);
    overrides.set(key, [...addresses]);
  } else overrides.delete(key);
  notify();
}

/** Acknowledging one request must not consume a newer edit made while it was in flight. */
export function consumeSuiteExecutionEnvironment(
  key: string,
  submitted: readonly string[] | undefined,
): void {
  if (overrides.get(key) === submitted) setSuiteExecutionEnvironment(key, undefined);
}

export function useSuiteExecutionEnvironment(userId: string, suiteId: string) {
  const key = executionEnvironmentDraftKey(userId, suiteId);
  const addresses = useSyncExternalStore(
    subscribe,
    () => readSuiteExecutionEnvironment(key),
    () => undefined,
  );
  return {
    key,
    addresses,
    setAddresses: (values: readonly string[] | undefined) =>
      setSuiteExecutionEnvironment(key, values),
  };
}
