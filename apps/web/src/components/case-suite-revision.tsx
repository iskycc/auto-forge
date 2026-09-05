"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

const RevisionContext = createContext<{
  revision: number;
  acceptMutation: (expectedRevision: number, savedRevision: number) => void;
} | null>(null);

export function CaseSuiteRevisionProvider({
  initialRevision,
  children,
}: {
  initialRevision: number;
  children: ReactNode;
}) {
  const [savedRevision, setSavedRevision] = useState(initialRevision);
  const revision = Math.max(initialRevision, savedRevision);

  function acceptMutation(expectedRevision: number, receivedRevision: number) {
    // A gap means another writer changed the suite; retain the stale revision for conflict review.
    setSavedRevision((current) =>
      Math.max(current, initialRevision) === expectedRevision &&
      receivedRevision === expectedRevision + 1
        ? receivedRevision
        : current,
    );
  }

  return (
    <RevisionContext.Provider value={{ revision, acceptMutation }}>
      {children}
    </RevisionContext.Provider>
  );
}

export function useCaseSuiteRevision() {
  const revision = useContext(RevisionContext);
  if (!revision) throw new Error("Case suite editing requires a shared revision scope.");
  return revision;
}
