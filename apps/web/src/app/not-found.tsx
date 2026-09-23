import { Result } from "antd";
import { LinkButton } from "@/components/ui/link-button";

export default function NotFound() {
  return (
    <main className="grid min-h-[calc(100vh_-_150px)] place-items-center">
      <Result
        status="404"
        title={<h1 className="text-2xl">页面不存在</h1>}
        subTitle="链接可能已失效，或者你没有可用的公开访问令牌。"
        extra={
          <LinkButton variant="primary" href="/">
            返回工作概览
          </LinkButton>
        }
      />
    </main>
  );
}
