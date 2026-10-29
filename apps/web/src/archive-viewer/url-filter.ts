import { useSyncExternalStore } from "react";
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
export function useUrlFilter(name: string): readonly [string, (value: string) => void] {
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => "",
  );
  const value = new URLSearchParams(search).get(name) ?? "";
  return [
    value,
    (next) => {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set(name, next);
      else url.searchParams.delete(name);
      window.history.pushState(null, "", url.href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  ];
}
