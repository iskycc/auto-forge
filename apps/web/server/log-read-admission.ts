/** Bound public SSR payloads as well as disk queries; public links do not require a session. */
export class LogReadAdmission {
  private active = 0;

  constructor(private readonly capacity = 8) {}

  acquire(
    method: string | undefined,
    rawUrl: string | undefined,
  ): { admitted: boolean; release(): void } {
    const path = (rawUrl ?? "").split("?", 1)[0]!;
    const logRead =
      (method === "GET" || method === "HEAD") &&
      (path.startsWith("/share/attempt-log/") ||
        /^\/share\/run\/[^/]+\/attempt\//.test(path) ||
        /^\/api\/v1\/run-attempts\/[^/]+\/logs$/.test(path));
    if (!logRead) return { admitted: true, release() {} };
    if (this.active >= this.capacity) return { admitted: false, release() {} };
    this.active += 1;
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (!released) {
          released = true;
          this.active -= 1;
        }
      },
    };
  }
}
