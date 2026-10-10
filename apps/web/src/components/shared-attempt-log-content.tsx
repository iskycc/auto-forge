import { isTerminalAttemptStatus } from "@autoforge/domain";
import { ManualSharedAttemptLogContent } from "@/components/manual-shared-attempt-log-content";
import {
  SharedAttemptLogLayout,
  type SharedAttemptLogContentProps,
} from "@/components/shared-attempt-log-layout";

export {
  InvalidAttemptLogShareView,
  SharedAttemptLogLoadingView,
} from "@/components/shared-attempt-log-layout";
export type { SharedLogRerunAccess } from "@/components/shared-attempt-log-layout";

/** Task and anonymous logs retain server-rendered snapshots without live client state. */
export function SharedAttemptLogContent(props: SharedAttemptLogContentProps) {
  const canReadLive = ["allowed", "read_only"].includes(props.rerunAccess);
  if (props.view.manualExecution && canReadLive && !isTerminalAttemptStatus(props.view.outcome)) {
    return <ManualSharedAttemptLogContent {...props} />;
  }
  return <SharedAttemptLogLayout {...props} />;
}
