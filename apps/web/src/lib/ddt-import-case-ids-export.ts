type ImportCaseId = { caseId: string; outcome: string };

export function ddtImportCaseIdsCsv(items: readonly ImportCaseId[]): Blob {
  return new Blob(
    // Excel opening a local CSV does not receive its MIME charset; the file needs its own UTF-8 marker.
    [
      "\uFEFFCaseID,结果\r\n",
      ...items.map((item) => `${csvCell(item.caseId)},${csvCell(item.outcome)}\r\n`),
    ],
    { type: "text/csv;charset=utf-8" },
  );
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
