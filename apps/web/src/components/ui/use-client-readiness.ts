"use client";

import { useSyncExternalStore } from "react";

function subscribeToClientReadiness(): () => void {
  return () => undefined;
}

function clientIsReady(): boolean {
  return true;
}

function serverIsNotReady(): boolean {
  return false;
}

/** Keep client-only actions disabled until hydration has attached their handlers. */
export function useClientReadiness(): boolean {
  return useSyncExternalStore(subscribeToClientReadiness, clientIsReady, serverIsNotReady);
}
