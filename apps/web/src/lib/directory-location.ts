/** Native history integrates with Next navigation without asking the server to rebuild the page. */
export function updateDirectoryLocation(
  values: Record<string, string | undefined>,
  navigation: "push" | "replace" = "replace",
) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (navigation === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}
