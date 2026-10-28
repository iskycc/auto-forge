import { expect, it, vi } from "vitest";
import type { DdtRepository } from "@autoforge/application";
import { readDdtCases } from "./ddt-case-reads";

it("bounds isolated DDT reads and rejects writes or oversized selections before repository access", async () => {
  const listCases = vi.fn().mockResolvedValue({ items: [] });
  const readExportCasesPage = vi.fn().mockResolvedValue({ items: [] });
  const repository = { listCases, readExportCasesPage } as unknown as DdtRepository;
  const scope = { projectId: "project", projectVersionId: "version", testStageId: "stage" };
  await expect(readDdtCases(repository, { method: "listCases", input: scope })).resolves.toEqual({
    items: [],
  });
  expect(listCases).toHaveBeenCalledWith({ ...scope, filters: [], limit: 60 });
  await expect(
    readDdtCases(repository, {
      method: "readExportCasesPage",
      input: { ...scope, cursor: "中文", srNum: "SR" },
    }),
  ).resolves.toEqual({ items: [] });
  for (const value of [
    { method: "trash", input: scope },
    { method: "listCases", input: { ...scope, limit: 100_000 } },
    {
      method: "readExportCasesPage",
      input: { ...scope, caseIds: Array.from({ length: 5_001 }, () => "id") },
    },
  ])
    expect(() => readDdtCases(repository, value)).toThrow();
  expect(listCases).toHaveBeenCalledOnce();
  expect(readExportCasesPage).toHaveBeenCalledOnce();
});

it.each(["listDeletedGroups", "listDeletedCases"] as const)(
  "isolates bounded %s reads and keeps an explicitly empty SR",
  async (method) => {
    const read = vi.fn().mockResolvedValue({ items: [] });
    const repository = { [method]: read } as unknown as DdtRepository;
    const scope = { projectId: "p", projectVersionId: "v", testStageId: "s" };
    await readDdtCases(repository, {
      method,
      input: { ...scope, ...(method === "listDeletedCases" ? { srNum: "" } : {}) },
    });
    expect(read).toHaveBeenCalledWith({
      ...scope,
      limit: method === "listDeletedGroups" ? 30 : 60,
      ...(method === "listDeletedCases" ? { srNum: "" } : {}),
    });
    expect(() => readDdtCases(repository, { method, input: { ...scope, limit: 101 } })).toThrow();
    expect(read).toHaveBeenCalledOnce();
  },
);
