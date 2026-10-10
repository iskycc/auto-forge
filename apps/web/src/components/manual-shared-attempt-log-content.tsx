"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  SharedAttemptLogLayout,
  type SharedAttemptLogContentProps,
} from "@/components/shared-attempt-log-layout";
import { useManualAttemptLiveLog } from "@/components/use-manual-attempt-live-log";

export function ManualSharedAttemptLogContent(props: SharedAttemptLogContentProps) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  const live = useManualAttemptLiveLog({
    attemptId: props.view.attemptId,
    enabled: true,
    initialStatus: props.view.outcome,
    initialText: props.view.logText,
    onFinished: refresh,
  });
  return (
    <SharedAttemptLogLayout
      {...props}
      live={live}
      view={{ ...props.view, outcome: live.status, logText: live.logText }}
    />
  );
}
