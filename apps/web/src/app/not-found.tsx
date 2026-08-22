import Link from "next/link";

export default function NotFound() {
  return (
    <main className="fatal-state">
      <p className="eyebrow">404</p>
      <h1>页面不存在</h1>
      <p>链接可能已失效，或者你没有可用的公开访问令牌。</p>
      <Link className="button button-primary" href="/">
        返回工作概览
      </Link>
    </main>
  );
}
