import { LoadingGlyph } from "./loading-state";

export function RouteLoadingSkeleton({ label }: { label: string }) {
  return (
    <div aria-live="polite" aria-busy="true" className="page-stack route-loading" role="status">
      <section className="page-hero route-loading-hero">
        <div>
          <span className="skeleton-line skeleton-eyebrow" />
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-copy" />
        </div>
        <LoadingGlyph />
      </section>
      <section className="content-card route-loading-card">
        <span className="route-loading-label">
          <strong>{label}</strong>
          <small>页面结构已就绪，正在读取最新数据。</small>
        </span>
        <div className="route-loading-toolbar">
          <span className="skeleton-block" />
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
        <div className="route-loading-rows" aria-hidden="true">
          {Array.from({ length: 7 }, (_, index) => (
            <span className="skeleton-row" key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}
