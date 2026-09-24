import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { LoadingGlyph } from "./loading-state";
import { Skeleton } from "./ui/skeleton";

export function RouteLoadingSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "page-stack route-loading",
        uiPatterns["page-stack"],
        routeLoadingSkeletonStyles["route-loading"],
      )}
      role="status"
    >
      <section
        className={cn(
          "page-hero route-loading-hero",
          uiPatterns["page-hero"],
          routeLoadingSkeletonStyles["route-loading-hero"],
        )}
      >
        <div>
          <Skeleton
            className={cn(
              "skeleton-line skeleton-eyebrow",
              routeLoadingSkeletonStyles["skeleton-line"],
              routeLoadingSkeletonStyles["skeleton-eyebrow"],
            )}
          />
          <Skeleton
            className={cn(
              "skeleton-line skeleton-title",
              routeLoadingSkeletonStyles["skeleton-line"],
              routeLoadingSkeletonStyles["skeleton-title"],
            )}
          />
          <Skeleton
            className={cn(
              "skeleton-line skeleton-copy",
              routeLoadingSkeletonStyles["skeleton-line"],
              routeLoadingSkeletonStyles["skeleton-copy"],
            )}
          />
        </div>
        <LoadingGlyph />
      </section>
      <Card
        as="section"
        className={cn(
          "content-card route-loading-card",
          uiPatterns["content-card"],
          routeLoadingSkeletonStyles["route-loading-card"],
        )}
      >
        <span
          className={cn("route-loading-label", routeLoadingSkeletonStyles["route-loading-label"])}
        >
          <strong>{label}</strong>
          <small>页面结构已就绪，正在读取最新数据。</small>
        </span>
        <div
          className={cn(
            "route-loading-toolbar",
            routeLoadingSkeletonStyles["route-loading-toolbar"],
          )}
        >
          <Skeleton
            className={cn("skeleton-block", routeLoadingSkeletonStyles["skeleton-block"])}
          />
          <Skeleton
            className={cn("skeleton-block", routeLoadingSkeletonStyles["skeleton-block"])}
          />
          <Skeleton
            className={cn("skeleton-block", routeLoadingSkeletonStyles["skeleton-block"])}
          />
        </div>
        <div
          className={cn("route-loading-rows", routeLoadingSkeletonStyles["route-loading-rows"])}
          aria-hidden="true"
        >
          {Array.from({ length: 6 }, (_, index) => (
            <div
              className="grid h-12 grid-cols-[minmax(0,2fr)_repeat(2,minmax(0,1fr))_5rem] items-center gap-4 border-b border-border last:border-0"
              key={index}
            >
              <Skeleton className={index % 2 === 0 ? "w-4/5" : "w-3/5"} />
              <Skeleton className="w-3/4" />
              <Skeleton className="w-2/3" />
              <Skeleton className="h-6 rounded-md" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

const routeLoadingSkeletonStyles = {
  "route-loading": "min-h-[60vh]",
  "route-loading-card": "relative overflow-hidden",
  "route-loading-hero": "relative overflow-hidden",
  "route-loading-label":
    "inline-grid gap-[3px] mb-4 text-muted-foreground text-sm [&_strong]:text-foreground [&_strong]:text-sm [&_small]:text-muted-foreground",
  "route-loading-rows": "grid",
  "route-loading-toolbar":
    "grid grid-cols-[minmax(12rem,_1fr)_minmax(10rem,_0.6fr)_8rem] gap-3 mb-4",
  "skeleton-block": "h-10",
  "skeleton-copy": "w-[min(36rem,_60vw)] h-[0.9rem]",
  "skeleton-eyebrow": "w-[7rem] h-[0.65rem] mb-3",
  "skeleton-line": "block",
  "skeleton-title": "w-[15rem] h-[2rem] mb-3",
} as const;
