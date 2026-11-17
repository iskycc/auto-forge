import type { ReactNode } from "react";
import { DocumentationShell } from "@/components/user-documentation/documentation-shell";
import { documentationSummaries } from "@/lib/user-documentation/catalog";

export default function DocumentationLayout({ children }: { children: ReactNode }) {
  return <DocumentationShell summaries={documentationSummaries}>{children}</DocumentationShell>;
}
