"use client";
import Link from "next/link";
import { useRef } from "react";
import { Tabs } from "./ui/tabs";
import { NavigationPendingIndicator } from "./navigation-pending-indicator";

export type SectionTab = {
  href: string;
  label: string;
  active: boolean;
};

export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  const navigationRef = useRef<HTMLElement>(null);
  return (
    <nav ref={navigationRef} className="section-tabs min-w-0" aria-label={label}>
      <Tabs
        label={label}
        value={tabs.find((tab) => tab.active)?.href ?? tabs[0]?.href ?? ""}
        items={tabs.map((tab) => ({
          key: tab.href,
          label: (
            <Link
              className="inline-flex items-center"
              onClick={(event) => event.stopPropagation()}
              aria-current={tab.active ? "page" : undefined}
              href={tab.href}
              scroll={false}
            >
              <SectionTabLabel label={tab.label} />
            </Link>
          ),
        }))}
        onChange={(href) => {
          // Keyboard activation follows the same Link and unsaved-form guard as a mouse click.
          const links = navigationRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]");
          Array.from(links ?? [])
            .find((link) => link.getAttribute("href") === href)
            ?.click();
        }}
      />
    </nav>
  );
}

/** Next 路由仍在服务端取数时给出即时反馈，避免点击后看起来像界面卡死。 */
function SectionTabLabel({ label }: { label: string }) {
  return (
    <>
      <span>{label}</span>
      <NavigationPendingIndicator className="ml-2" />
    </>
  );
}
