"use client";

import { useEffect } from "react";

const SESSION_CHECK_TIMEOUT_MS = 5_000;

/** Recover Strict cookies omitted on the initial cross-site Jenkins navigation. */
export function AuthenticatedRunRedirect({ batchId }: { batchId: string }) {
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SESSION_CHECK_TIMEOUT_MS);
    const encodedBatchId = encodeURIComponent(batchId);

    // Use the authenticated, project-scoped metadata endpoint without the share
    // token. A public link must never grant console permissions. This optional
    // probe fails closed and leaves the existing public report usable on errors.
    void fetch(`/api/v1/run-batches/${encodedBatchId}?view=summary`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(
        (response) => response.ok,
        () => false,
      )
      .then((authorized) => {
        window.clearTimeout(timeout);
        if (authorized && !controller.signal.aborted) {
          // Reload the root layout too: the first cross-site response may have
          // rendered it without a user or navigation permissions.
          window.location.replace(`/run-batches/${encodedBatchId}`);
        }
      });

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [batchId]);

  return null;
}
