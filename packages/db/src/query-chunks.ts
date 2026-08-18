/**
 * 单次 IN 列表的取值上限。SQLite 绑定变量数（SQLITE_MAX_VARIABLE_NUMBER）与 pg 协议
 * 都会限制单条语句可携带的参数数量，大批量校验/查询必须分批进行，避免触顶报错。
 */
export const QUERY_IN_CHUNK_SIZE = 5_000;

export function splitIntoChunks<T>(values: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += chunkSize) {
    chunks.push(values.slice(start, start + chunkSize));
  }
  return chunks;
}
