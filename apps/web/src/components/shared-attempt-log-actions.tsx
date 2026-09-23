"use client";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { RunAttempt } from "@autoforge/domain";
import { isTerminalAttemptStatus } from "@autoforge/domain";
import { Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { AttemptLogViewer } from "@/components/attempt-log-viewer";
import { AttemptRerunAction, type LiveLogAttempt } from "@/components/attempt-rerun-action";
import { Button } from "@/components/ui";

/** 登录用户在永久日志详情页直接打开当前手动执行或新提交重跑的实时日志。 */
export function SharedAttemptLogActions({
  attempt,
  canCreateRuns,
}: {
  attempt: Pick<RunAttempt, "id" | "status">;
  canCreateRuns: boolean;
}) {
  const router = useRouter();
  const [openAttempt, setOpenAttempt] = useState<LiveLogAttempt | null>(null);
  const terminal = isTerminalAttemptStatus(attempt.status);
  const refreshExecutionHistory = useCallback(() => router.refresh(), [router]);
  return (
    <div
      className={cn(
        "shared-attempt-log-actions",
        sharedAttemptLogActionsStyles["shared-attempt-log-actions"],
      )}
    >
      {!terminal ? (
        <Button
          className={cn(
            "button button-primary",
            uiPatterns["button"],
            uiPatterns["button-primary"],
          )}
          onClick={() => setOpenAttempt(attempt)}
          type="button"
          variant="primary"
        >
          <Radio size={15} /> 查看实时日志
        </Button>
      ) : null}
      {terminal && canCreateRuns ? (
        <AttemptRerunAction
          attemptId={attempt.id}
          onOpenLiveLogs={setOpenAttempt}
          onRerunAttemptAvailable={refreshExecutionHistory}
        />
      ) : null}
      {openAttempt ? (
        <AttemptLogViewer
          attemptId={openAttempt.id}
          attemptStatus={openAttempt.status}
          canCreateRuns={false}
          canReadLogs
          onClose={() => setOpenAttempt(null)}
        />
      ) : null}
    </div>
  );
}

const sharedAttemptLogActionsStyles = {
  "shared-attempt-log-actions": "[&_>_.button]:mb-4.5",
} as const;
