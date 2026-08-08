"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="fatal-state">
      <span className="fatal-icon">
        <AlertTriangle size={28} />
      </span>
      <h1>页面加载失败</h1>
      <p>请检查 Lite 数据目录和 SQLite 文件权限，然后重试。</p>
      <button className="button button-primary" type="button" onClick={reset}>
        <RotateCcw size={17} /> 重试
      </button>
    </div>
  );
}
