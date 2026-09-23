"use client";
import { cn } from "@/lib/utils";

import Link from "next/link";
import { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { Tabs } from "./ui/tabs";

export type SectionTab = {
  href: string;
  label: string;
  active: boolean;
};

export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  const router = useRouter();
  return (
    <nav className="section-tabs min-w-0" aria-label={label}>
      <Tabs
        label={label}
        value={tabs.find((tab) => tab.active)?.href ?? tabs[0]?.href ?? ""}
        items={tabs.map((tab) => ({
          key: tab.href,
          label: (
            <Link
              onClick={(event) => event.stopPropagation()}
              aria-current={tab.active ? "page" : undefined}
              href={tab.href}
            >
              <SectionTabLabel label={tab.label} />
            </Link>
          ),
        }))}
        onChange={(href) => router.push(href)}
      />
    </nav>
  );
}

/** Next 路由仍在服务端取数时给出即时反馈，避免点击后看起来像界面卡死。 */
function SectionTabLabel({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          sectionTabsStyles["section-tab-pending"],
          `section-tab-pending${pending ? " visible" : ""}`,
        )}
      />
    </>
  );
}

const sectionTabsStyles = {
  "section-tab-pending":
    "w-[5px] h-[5px] ml-[7px] rounded-full bg-current opacity-0 [transform:scale(0.5)] transition-colors duration-150 motion-reduce:transition-none [&.visible]:opacity-75 [&.visible]:[transform:scale(1)] [&.visible]:animate-pulse [&.visible]:motion-reduce:animate-none",
} as const;
