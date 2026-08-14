import type { CaseCatalogRepository, CaseListQuery } from "@autoforge/application";
import type { CaseDefinitionWithMethods } from "@autoforge/domain";

const DIRECTORY_READ_BATCH_SIZE = 500;

type CompleteDirectoryQuery = Omit<CaseListQuery, "cursor" | "limit">;

export async function listCompleteCaseDirectory(
  catalog: Pick<CaseCatalogRepository, "listCases">,
  query: CompleteDirectoryQuery,
): Promise<CaseDefinitionWithMethods[]> {
  const items: CaseDefinitionWithMethods[] = [];
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await catalog.listCases({
      ...query,
      ...(cursor ? { cursor } : {}),
      limit: DIRECTORY_READ_BATCH_SIZE,
    });
    items.push(...page.items);

    if (!page.nextCursor) break;
    if (visitedCursors.has(page.nextCursor)) {
      throw new Error(`Case directory pagination repeated cursor ${page.nextCursor}.`);
    }
    visitedCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);

  return items;
}
