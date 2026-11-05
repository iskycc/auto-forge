import {
  failureAnalysisSheetQuerySchema,
  type FailureAnalysisSheetQuery,
} from "@autoforge/contracts";

export function analysisSheetQuery(
  parameters: Pick<URLSearchParams, "get">,
  currentUserId: string | null,
) {
  const input = {
    view: currentUserId && parameters.get("sheetView") === "mine" ? "mine" : "all",
    query: parameters.get("sheetQuery")?.slice(0, 240) ?? "",
    sort: parameters.get("sheetSort") ?? "class_path",
    direction: parameters.get("sheetDirection") ?? "asc",
    limit: 50,
  };
  const result = failureAnalysisSheetQuerySchema.safeParse(input);
  return result.success ? result.data : failureAnalysisSheetQuerySchema.parse({});
}

export function analysisSheetSearchParameters(
  parameters: Record<string, string | string[] | undefined>,
) {
  return new URLSearchParams(
    Object.entries(parameters).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

export function analysisSheetFilterUrl(href: string, query: FailureAnalysisSheetQuery) {
  const url = new URL(href);
  url.searchParams.set("sheetView", query.view);
  url.searchParams.set("sheetSort", query.sort);
  url.searchParams.set("sheetDirection", query.direction);
  if (query.query) url.searchParams.set("sheetQuery", query.query);
  else url.searchParams.delete("sheetQuery");
  return url;
}
