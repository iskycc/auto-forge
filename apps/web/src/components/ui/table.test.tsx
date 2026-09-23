import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import { Button } from "./button";

function SortableBusinessHeading() {
  return (
    <TableHead aria-sort="ascending">
      <Button>执行机排序</Button>
    </TableHead>
  );
}

function ExpandedBusinessRow() {
  return (
    <>
      <TableRow>
        <TableCell>runner-a</TableCell>
        <TableCell>已完成</TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={2}>展开的执行详情</TableCell>
      </TableRow>
    </>
  );
}

describe("Ant Design business table", () => {
  it("renders accessible headers and custom expanded rows without losing cells or column spans", () => {
    const html = renderToStaticMarkup(
      <Table aria-label="执行记录" className="[table-layout:fixed]">
        <colgroup>
          <col className="identity-column" />
          <col />
        </colgroup>
        <TableHeader>
          <TableRow>
            <SortableBusinessHeading />
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <ExpandedBusinessRow />
        </TableBody>
      </Table>,
    );
    expect(html).toContain("ant-table-wrapper");
    expect(html).not.toContain("table-layout:auto");
    expect(html).toContain("[table-layout:fixed]");
    expect(html).toContain('aria-label="执行记录"');
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('class="identity-column"');
    expect(html).toContain('colSpan="2"');
    expect(html).toContain("runner-a");
    expect(html).toContain("展开的执行详情");
    expect(html.match(/<td\b/g)).toHaveLength(3);
    expect(html.match(/<th\b/g)).toHaveLength(2);
  });

  it("keeps the caller's explicit empty row and does not add a second empty placeholder", () => {
    const html = renderToStaticMarkup(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>用例</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>暂无用例</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(html.match(/暂无用例/g)).toHaveLength(1);
    expect(html.match(/<td\b/g)).toHaveLength(1);
    expect(html).not.toContain("ant-empty");
  });
});
