"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "./ui";

export function RefreshAuditButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw size={16} className={pending ? "spin" : undefined} />
      {pending ? "正在刷新" : "刷新日志"}
    </Button>
  );
}
