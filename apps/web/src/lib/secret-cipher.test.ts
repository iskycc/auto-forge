import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AesGcmSecretCipher } from "./secret-cipher";

describe("AesGcmSecretCipher", () => {
  it("encrypts authenticated Runner connection payloads without plaintext leakage", () => {
    const cipher = new AesGcmSecretCipher(randomBytes(32).toString("base64"));
    const plaintext = JSON.stringify({
      host: "10.20.30.40",
      username: "automation",
      password: "Password!Runner123",
    });
    const ciphertext = cipher.encrypt(plaintext, "runner-installation-profile:profile-1");

    expect(ciphertext).not.toContain("10.20.30.40");
    expect(ciphertext).not.toContain("Password!Runner123");
    expect(cipher.decrypt(ciphertext, "runner-installation-profile:profile-1")).toBe(plaintext);
    expect(() => cipher.decrypt(ciphertext, "runner-installation-profile:profile-2")).toThrow(
      "无法使用当前主密钥解密密文",
    );
  });
});
