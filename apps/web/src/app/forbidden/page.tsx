import { Result } from "antd";
import { LinkButton } from "@/components/ui/link-button";

export default function ForbiddenPage() {
  return (
    <section className="grid min-h-[calc(100vh_-_128px)] place-items-center">
      <Result
        status="403"
        title={<h1 className="text-2xl">没有访问权限</h1>}
        subTitle="当前账号无权查看此内容。请联系项目或系统管理员调整角色。"
        extra={<LinkButton href="/">返回首页</LinkButton>}
      />
    </section>
  );
}
