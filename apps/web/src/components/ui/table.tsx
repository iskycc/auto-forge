import { Children, isValidElement, type ComponentProps, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { AntBusinessTable } from "./business-table";

// Ant Table owns the table surface and header. Custom row components retain
// bounded rendering, expanded details and state instead of being evaluated here.
export function Table({ children, ...props }: ComponentProps<"table">) {
  const sections = Children.toArray(children);
  const header = sections.find(
    (child): child is ReactElement<ComponentProps<"thead">> =>
      isValidElement(child) && child.type === TableHeader,
  );
  const body = sections.find(
    (child): child is ReactElement<ComponentProps<"tbody">> =>
      isValidElement(child) && child.type === TableBody,
  );
  const headerRow = Children.toArray(header?.props.children).find(
    (child): child is ReactElement<ComponentProps<"tr">> =>
      isValidElement(child) && child.type === TableRow,
  );
  const headings = Children.toArray(headerRow?.props.children);
  const headerProps = { ...header?.props };
  delete headerProps.children;
  const headerRowProps = { ...headerRow?.props };
  delete headerRowProps.children;
  const { children: bodyChildren, ...bodyProps } = body?.props ?? {};
  return (
    <AntBusinessTable
      tableProps={props}
      headerProps={headerProps}
      headerRowProps={headerRowProps}
      bodyProps={bodyProps}
      headings={headings}
      rows={Children.toArray(bodyChildren)}
      columnGroups={sections.filter((child) => isValidElement(child) && child.type === "colgroup")}
    />
  );
}
export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-muted/60", className)} {...props} />;
}
export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}
export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "ant-table-row border-b border-border transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      data-slot="table-head"
      className={cn(
        "ant-table-cell h-10 px-4 py-2 text-left align-middle text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("ant-table-cell px-4 py-3 align-middle", className)}
      {...props}
    />
  );
}
