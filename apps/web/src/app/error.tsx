"use client";

import { Result } from "antd";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid min-h-[calc(100vh_-_150px)] place-items-center">
      <Result
        status="warning"
        title={<h1 className="text-2xl">页面加载失败</h1>}
        subTitle="请重试；若问题持续，请联系管理员检查平台诊断和服务日志。"
        extra={
          <Button variant="primary" type="button" onClick={reset}>
            <RotateCcw size={17} /> 重试
          </Button>
        }
      />
    </div>
  );
}
