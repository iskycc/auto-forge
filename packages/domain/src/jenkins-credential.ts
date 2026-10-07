import { DomainError } from "./errors";

export function assertJenkinsCredential(value: string): void {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new DomainError(
      "JENKINS_CREDENTIAL_INVALID",
      "Jenkins API 密钥需填写为“用户名:API Token”。",
    );
  }
}

export function assertSameJenkinsOrigin(sourceUrl: string, targetUrl: string): void {
  if (new URL(sourceUrl).origin !== new URL(targetUrl).origin) {
    throw new DomainError(
      "JENKINS_CREDENTIAL_ORIGIN_MISMATCH",
      "复用密钥仅适用于同一 Jenkins 服务地址；不同地址请单独输入密钥。",
    );
  }
}
