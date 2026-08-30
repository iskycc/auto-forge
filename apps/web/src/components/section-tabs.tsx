"use client";

import Link from "next/link";
import { useLinkStatus } from "next/link";

export type SectionTab = {
  href: string;
  label: string;
  active: boolean;
};

export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <Link aria-current={tab.active ? "page" : undefined} href={tab.href} key={tab.href}>
          <SectionTabLabel label={tab.label} />
        </Link>
      ))}
    </nav>
  );
}

/** Next 路由仍在服务端取数时给出即时反馈，避免点击后看起来像界面卡死。 */
function SectionTabLabel({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span>{label}</span>
      <span aria-hidden="true" className={`section-tab-pending${pending ? " visible" : ""}`} />
    </>
  );
}
