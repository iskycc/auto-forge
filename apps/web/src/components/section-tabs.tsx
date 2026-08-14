import Link from "next/link";

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
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
