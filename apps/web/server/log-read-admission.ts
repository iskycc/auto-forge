/** Bound public SSR payloads as well as disk queries; public links do not require a session. */
export class LogReadAdmission {
  private active = 0;
  private activeArchives = 0;

  constructor(private readonly capacity = 8) {}

  acquire(
    method: string | undefined,
    rawUrl: string | undefined,
  ): { admitted: boolean; release(): void } {
    const path = (rawUrl ?? "").split("?", 1)[0]!;
    const archive =
      method === "GET" && /^\/api\/v1\/run-batches\/[^/]+\/failure-logs\/export$/.test(path);
    const logRead =
      (method === "GET" || method === "HEAD") &&
      (path === "/CaseLog" ||
        path.startsWith("/share/attempt-log/") ||
        /^\/share\/run\/[^/]+\/attempt\//.test(path) ||
        /^\/api\/v1\/run-attempts\/[^/]+\/logs$/.test(path));
    if (!archive && !logRead) return { admitted: true, release() {} };
    if (archive ? this.activeArchives >= 2 : this.active >= this.capacity)
      return { admitted: false, release() {} };
    if (archive) this.activeArchives += 1;
    else this.active += 1;
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (!released) {
          released = true;
          if (archive) this.activeArchives -= 1;
          else this.active -= 1;
        }
      },
    };
  }
}
