import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <section className="page-stack compact-page">
      <div className="empty-state-card">
        <strong>没有访问权限</strong>
        <p>当前账号无权查看此内容。请联系项目或系统管理员调整角色。</p>
        <Link className="button button-secondary" href="/">
          返回首页
        </Link>
      </div>
    </section>
  );
}
