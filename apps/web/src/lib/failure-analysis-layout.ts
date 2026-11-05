/** Explicit layout wins; old claim/workbench deep links retain their original workspace. */
export function analysisWorkspaceLayout(
  parameters: Pick<URLSearchParams, "get">,
): "sheet" | "classic" {
  const layout = parameters.get("layout");
  if (layout === "sheet" || layout === "classic") return layout;
  return parameters.get("view") === "claim" || parameters.get("view") === "workbench"
    ? "classic"
    : "sheet";
}
