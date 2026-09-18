import { readCaseListFileColumn } from "./case-list-file";
import { parseCasePathCells } from "./case-path-import";

export {
  MAX_CASE_LIST_FILE_BYTES as MAX_CASE_PATH_FILE_BYTES,
  MAX_CASE_LIST_ROWS as MAX_CASE_PATH_ROWS,
} from "./case-list-file";

export async function parseCasePathFile(
  file: Parameters<typeof readCaseListFileColumn>[0],
): Promise<string[]> {
  return parseCasePathCells(await readCaseListFileColumn(file));
}
