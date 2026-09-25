"use client";

import { Result } from "antd";
import { RotateCcw } from "lucide-react";
import { Button } from "./ui";

export function SharedLogError({ reset }: { reset: () => void }) {
  return (
    <Result
      status="error"
      className="min-h-[calc(100vh-150px)] content-center"
      title={<h1 className="m-0 text-xl">日志暂时无法读取</h1>}
      subTitle="日志服务繁忙或节点暂不可用，请稍后重试。"
      extra={
        <Button type="button" variant="primary" onClick={reset}>
          <RotateCcw size={17} />
          重试
        </Button>
      }
    />
  );
}
