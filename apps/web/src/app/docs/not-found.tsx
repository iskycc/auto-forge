"use client";

import { Button, Result } from "antd";

export default function DocumentationNotFound() {
  return (
    <Result
      status="404"
      title="未找到这篇说明"
      subTitle="请从文档目录选择功能，或搜索相关关键词。"
      extra={
        <Button href="/docs" type="primary">
          文档首页
        </Button>
      }
    />
  );
}
