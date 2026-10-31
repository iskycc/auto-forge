export type FileStorageSection = "sources" | "storage" | "archives";

export function fileStorageLocation(
  section: FileStorageSection,
  filters: { category?: string; query?: string } = {},
): string {
  const query = new URLSearchParams({ section });
  if (typeof filters.category === "string" && filters.category)
    query.set("category", filters.category);
  if (typeof filters.query === "string" && filters.query) query.set("query", filters.query);
  return `/objects?${query}`;
}
