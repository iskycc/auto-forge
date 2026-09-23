"use client";

import { Table as AntTable, type TableProps } from "antd";
import {
  createContext,
  isValidElement,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

type TableParts = {
  tableProps: ComponentProps<"table">;
  headerProps: ComponentProps<"thead">;
  headerRowProps: ComponentProps<"tr">;
  bodyProps: ComponentProps<"tbody">;
  headings: ReactNode[];
  rows: ReactNode[];
  columnGroups: ReactNode;
};
type BusinessRow = { key: string; content: ReactNode };
const PartsContext = createContext<TableParts | null>(null);
const RowsContext = createContext<ReadonlyMap<string, ReactNode>>(new Map());

function useParts(): TableParts {
  const parts = useContext(PartsContext);
  if (!parts) throw new Error("Business table parts must be rendered inside AntBusinessTable.");
  return parts;
}

function TableElement({ children, ...generated }: ComponentProps<"table">) {
  const { tableProps, columnGroups } = useParts();
  const tableStyle = { ...generated.style, ...tableProps.style };
  // Existing execution tables own fixed/resizable columns through their layout classes.
  // Ant's default inline "auto" would override those rules.
  if (!tableProps.style?.tableLayout) delete tableStyle.tableLayout;
  return (
    <table
      {...generated}
      {...tableProps}
      style={tableStyle}
      data-slot="table"
      className={cn("w-full text-left text-sm", generated.className, tableProps.className)}
    >
      {columnGroups}
      {children}
    </table>
  );
}

function Header({ children, ...generated }: ComponentProps<"thead">) {
  const { headerProps } = useParts();
  return (
    <thead
      {...generated}
      {...headerProps}
      data-slot="table-header"
      className={cn(generated.className, headerProps.className)}
    >
      {children}
    </thead>
  );
}

function Body({ children, ...generated }: ComponentProps<"tbody">) {
  const { bodyProps } = useParts();
  return (
    <tbody
      {...generated}
      {...bodyProps}
      data-slot="table-body"
      className={cn(generated.className, bodyProps.className)}
    >
      {children}
    </tbody>
  );
}

function Row(props: ComponentProps<"tr"> & { "data-row-key"?: string }) {
  return useContext(RowsContext).get(props["data-row-key"] ?? "") ?? null;
}

function HeaderCell({ children }: ComponentProps<"th">) {
  // Sortable headings are business components that render their own accessible th.
  return children;
}

const components: NonNullable<TableProps<BusinessRow>["components"]> = {
  table: TableElement,
  header: { wrapper: Header, cell: HeaderCell },
  body: { wrapper: Body, row: Row },
};

/** Use Ant Table's supported custom-row API without introducing a second paginator or scroll area. */
export function AntBusinessTable(parts: TableParts) {
  const rows = parts.rows.map((content, index): BusinessRow => ({
    key: isValidElement(content) && content.key !== null ? String(content.key) : String(index),
    content,
  }));
  const columns: TableProps<BusinessRow>["columns"] = parts.headings.map((heading, index) => ({
    key: String(index),
    title: heading,
  }));
  return (
    <PartsContext.Provider value={parts}>
      <RowsContext.Provider value={new Map(rows.map((row) => [row.key, row.content]))}>
        <AntTable<BusinessRow>
          className="ui-business-table min-w-0"
          size="small"
          pagination={false}
          columns={columns}
          dataSource={rows}
          components={components}
          onHeaderRow={() => parts.headerRowProps}
          locale={{ emptyText: null }}
        />
      </RowsContext.Provider>
    </PartsContext.Provider>
  );
}
