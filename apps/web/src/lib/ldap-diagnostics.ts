import { DomainError } from "@autoforge/domain";

export type LdapOperationPhase = "connect" | "bind" | "search";

export function ldapDiagnostic(error: unknown, phase: LdapOperationPhase): DomainError {
  if (error instanceof DomainError) return error;
  const signal = errorSignal(error);
  if (matches(signal, ["ENOTFOUND", "EAI_AGAIN", "getaddrinfo"])) {
    return diagnostic(
      "LDAP_DNS_FAILED",
      "LDAP 服务器名称无法解析，请检查 DNS 和服务器地址。",
      error,
    );
  }
  if (
    matches(signal, [
      "ERR_TLS",
      "CERT_",
      "certificate",
      "self signed",
      "unable_to_verify",
      "unable to verify",
      "hostname",
    ])
  ) {
    return diagnostic(
      "LDAP_TLS_FAILED",
      "LDAP TLS 校验失败，请检查主机名、证书有效期和私有 CA。",
      error,
    );
  }
  if (matches(signal, ["ETIMEDOUT", "ESOCKETTIMEDOUT", "timeout", "timed out"])) {
    return diagnostic(
      "LDAP_CONNECTION_TIMEOUT",
      "LDAP 连接或操作超时，请检查网络和超时配置。",
      error,
    );
  }
  if (phase === "bind") {
    if (
      matches(signal, ["InvalidCredentials", "invalid credentials", "code 49", "resultCode: 49"])
    ) {
      return diagnostic("LDAP_BIND_REJECTED", "LDAP bind 凭据被目录拒绝。", error);
    }
    if (matches(signal, ["InsufficientAccessRights", "code 50", "resultCode: 50"])) {
      return diagnostic("LDAP_BIND_FORBIDDEN", "LDAP bind 账号没有所需权限。", error);
    }
  }
  if (phase === "search") {
    if (matches(signal, ["NoSuchObject", "code 32", "resultCode: 32"])) {
      return diagnostic("LDAP_BASE_DN_NOT_FOUND", "LDAP Base DN 不存在或 bind 账号不可见。", error);
    }
    if (matches(signal, ["FilterError", "invalid filter", "code 87", "resultCode: 87"])) {
      return diagnostic("LDAP_FILTER_INVALID", "LDAP 过滤器无效，请检查占位符和目录语法。", error);
    }
    if (matches(signal, ["InsufficientAccessRights", "code 50", "resultCode: 50"])) {
      return diagnostic(
        "LDAP_READ_FORBIDDEN",
        "LDAP bind 账号没有读取配置 Base DN 的权限。",
        error,
      );
    }
    return diagnostic(
      "LDAP_SEARCH_FAILED",
      "LDAP 搜索失败，请检查 Base DN、过滤器和读取权限。",
      error,
    );
  }
  return diagnostic(
    "LDAP_CONNECTION_FAILED",
    "无法连接 LDAP 服务器，请检查地址、端口和网络策略。",
    error,
  );
}

export function combinedLdapFailure(failures: readonly DomainError[]): DomainError {
  const codes = [...new Set(failures.map((failure) => failure.code))];
  if (codes.length === 1 && failures[0]) {
    return new DomainError(failures[0].code, failures[0].message, {
      cause: new AggregateError(failures, "All configured LDAP servers failed"),
    });
  }
  return new DomainError(
    "LDAP_DIRECTORY_UNAVAILABLE",
    `所有 LDAP 服务器均不可用；诊断阶段：${codes.join("、")}。`,
    { cause: new AggregateError(failures, "All configured LDAP servers failed") },
  );
}

function diagnostic(code: string, message: string, cause: unknown): DomainError {
  return new DomainError(code, message, { cause });
}

function errorSignal(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const record = error as Error & { code?: unknown; errno?: unknown; resultCode?: unknown };
  return [record.name, record.message, record.code, record.errno, record.resultCode]
    .filter((value) => value !== undefined)
    .join(" ");
}

function matches(signal: string, candidates: readonly string[]): boolean {
  const normalized = signal.toLowerCase();
  return candidates.some((candidate) => normalized.includes(candidate.toLowerCase()));
}
