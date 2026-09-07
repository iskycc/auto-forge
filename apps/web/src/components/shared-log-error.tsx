"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "./ui";

export function SharedLogError({ reset }: { reset: () => void }) {
  return (
    <div className="fatal-state" role="alert">
      <span className="fatal-icon">
        <AlertTriangle size={28} />
      </span>
      <h1>日志暂时无法读取</h1>
      <p>日志服务繁忙或节点暂不可用，请稍后重试。</p>
      <Button className="button button-primary" type="button" onClick={reset}>
        <RotateCcw size={17} /> 重试
      </Button>
    </div>
  );
}
