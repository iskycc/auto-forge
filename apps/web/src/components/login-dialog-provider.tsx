"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { LoginDialog } from "./login-dialog";

type LoginSessionState =
  { status: "checking" | "anonymous" | "authenticated" } | { status: "failed"; message: string };

type LoginDialogContextValue = {
  openLogin: () => void;
  retrySessionCheck: () => void;
  session: LoginSessionState;
};

const LoginDialogContext = createContext<LoginDialogContextValue | null>(null);
const SESSION_CHECK_TIMEOUT_MS = 5_000;

/** One login dialog and bounded session recovery for console and public pages. */
export function LoginDialogProvider({
  children,
  hasSession,
}: {
  children: ReactNode;
  hasSession: boolean;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [session, setSession] = useState<LoginSessionState>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);

  const openLogin = useCallback(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("login") === "1") return;
    url.searchParams.set("login", "1");
    window.history.pushState(null, "", url);
  }, []);

  const closeLogin = useCallback(() => {
    window.history.replaceState(null, "", loginReturnUrl());
  }, []);

  const refreshIdentity = useCallback(() => {
    closeLogin();
    // Merge authenticated server content without replacing the log document or its scroll state.
    startRefresh(() => router.refresh());
  }, [closeLogin, router]);

  const retrySessionCheck = useCallback(() => {
    setSession({ status: "checking" });
    setAttempt((previous) => previous + 1);
  }, []);

  useEffect(() => {
    if (hasSession) return;
    const controller = new AbortController();
    let disposed = false;
    const timeout = window.setTimeout(() => controller.abort(), SESSION_CHECK_TIMEOUT_MS);
    async function checkSession(): Promise<void> {
      try {
        // Strict cookies may be absent on the first cross-site document request.
        // Recover identity through the same origin without leaving this page.
        const response = await fetch("/api/v1/auth/session", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (disposed) return;
        if (!response.ok && response.status !== 401)
          throw new Error(`确认登录状态失败（HTTP ${response.status}）。`);
        setSession({ status: "anonymous" });
        if (response.ok) {
          refreshIdentity();
        }
      } catch (cause) {
        if (!disposed) {
          setSession({
            status: "failed",
            message: controller.signal.aborted
              ? "确认登录状态超时，请重试。"
              : cause instanceof Error
                ? cause.message
                : "无法确认登录状态，请重试。",
          });
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }
    void checkSession();
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [hasSession, attempt, refreshIdentity]);

  const context = useMemo<LoginDialogContextValue>(
    () => ({
      openLogin,
      retrySessionCheck,
      session: hasSession
        ? { status: "authenticated" }
        : refreshing
          ? { status: "checking" }
          : session,
    }),
    [hasSession, openLogin, refreshing, retrySessionCheck, session],
  );

  return (
    <LoginDialogContext.Provider value={context}>
      {children}
      <LoginDialog
        open={searchParams.get("login") === "1"}
        passwordChanged={searchParams.get("passwordChanged") === "1"}
        onClose={closeLogin}
        onAuthenticated={refreshIdentity}
      />
    </LoginDialogContext.Provider>
  );
}

function loginReturnUrl(): URL {
  const url = new URL(window.location.href);
  url.searchParams.delete("login");
  url.searchParams.delete("passwordChanged");
  return url;
}

export function useLoginDialog(): LoginDialogContextValue {
  const context = useContext(LoginDialogContext);
  if (!context) throw new Error("Login controls require LoginDialogProvider.");
  return context;
}
