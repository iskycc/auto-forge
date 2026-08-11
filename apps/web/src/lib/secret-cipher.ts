import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { SecretCipherPort } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

export class AesGcmSecretCipher implements SecretCipherPort {
  readonly available: boolean;
  private readonly key: Buffer | undefined;

  constructor(base64Key: string | undefined) {
    if (!base64Key) {
      this.available = false;
      return;
    }
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) {
      throw new Error("平台主密钥必须是 32 字节随机值的 Base64 编码。");
    }
    this.key = key;
    this.available = true;
  }

  encrypt(plaintext: string, purpose: string): string {
    const key = this.requiredKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    cipher.setAAD(Buffer.from(purpose, "utf8"));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      nonce.toString("base64url"),
      encrypted.toString("base64url"),
      tag.toString("base64url"),
    ].join(".");
  }

  decrypt(ciphertext: string, purpose: string): string {
    const key = this.requiredKey();
    const [version, nonceValue, contentValue, tagValue, extra] = ciphertext.split(".");
    if (version !== VERSION || !nonceValue || contentValue === undefined || !tagValue || extra) {
      throw new DomainError("SECRET_CIPHERTEXT_INVALID", "密文格式无效。");
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(nonceValue, "base64url"));
      decipher.setAAD(Buffer.from(purpose, "utf8"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(contentValue, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      throw new DomainError("SECRET_DECRYPTION_FAILED", "无法使用当前主密钥解密密文。", {
        cause: error,
      });
    }
  }

  private requiredKey(): Buffer {
    if (!this.key) {
      throw new DomainError("SECRET_CIPHER_UNAVAILABLE", "AutoForge 主密钥未配置。");
    }
    return this.key;
  }
}
