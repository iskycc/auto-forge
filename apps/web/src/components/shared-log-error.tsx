"use client";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "./ui";

export function SharedLogError({ reset }: { reset: () => void }) {
  return (
    <div className={cn("fatal-state", sharedLogErrorStyles["fatal-state"])} role="alert">
      <span className={cn("fatal-icon", sharedLogErrorStyles["fatal-icon"])}>
        <AlertTriangle size={28} />
      </span>
      <h1>日志暂时无法读取</h1>
      <p>日志服务繁忙或节点暂不可用，请稍后重试。</p>
      <Button
        className={cn("button button-primary", uiPatterns["button"], uiPatterns["button-primary"])}
        type="button"
        onClick={reset}
      >
        <RotateCcw size={17} /> 重试
      </Button>
    </div>
  );
}

const sharedLogErrorStyles = {
  "fatal-icon":
    "grid w-14.5 h-14.5 place-items-center rounded-xl bg-destructive/10 text-destructive",
  "fatal-state":
    "flex min-h-[calc(100vh_-_150px)] items-center justify-center flex-col text-center [&_h1]:[margin:18px_0_5px] [&_h1]:text-2xl [&_p]:[margin:0_0_20px] [&_p]:text-muted-foreground",
} as const;
