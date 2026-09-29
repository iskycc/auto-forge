/** Personal DDT URLs carry a read capability; access logs must not preserve it. */
export function redactRequestPath(path: string): string {
  return path.replace(
    /(\/api\/v1\/public\/ddt\/projects\/[^/]+\/versions\/[^/]+\/stages\/[^/]+\/users\/[^/]+\/debug\/)[^/?#]+/gu,
    "$1[REDACTED]",
  );
}
