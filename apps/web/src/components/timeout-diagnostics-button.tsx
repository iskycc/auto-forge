"use client";

import { useState } from "react";
import { AttemptLogViewer } from "./attempt-log-viewer";
import { Button } from "./ui";

/** Reuse the authenticated log reader; public links grant no Agent-diagnostic access. */
export function TimeoutDiagnosticsButton({ attemptId }: { attemptId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="compact" onClick={() => setOpen(true)}>
        查看超时诊断
      </Button>
      {open ? (
        <AttemptLogViewer
          attemptId={attemptId}
          attemptStatus="timed_out"
          canReadLogs
          canRetryRuns={false}
          initialStream="agent"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
