import "server-only";

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

import type { PasswordHashPort } from "@autoforge/application";

const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_BYTES = 32;
const MAXIMUM_MEMORY_BYTES = 64 * 1024 * 1024;

export class ScryptPasswordHasher implements PasswordHashPort {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const digest = await derive(password, salt, COST, BLOCK_SIZE, PARALLELIZATION);
    return [
      "scrypt",
      COST,
      BLOCK_SIZE,
      PARALLELIZATION,
      salt.toString("base64url"),
      digest.toString("base64url"),
    ].join("$");
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    const parsed = parseEncodedHash(encodedHash);
    if (!parsed) return false;
    const actual = await derive(
      password,
      parsed.salt,
      parsed.cost,
      parsed.blockSize,
      parsed.parallelization,
    );
    return actual.length === parsed.digest.length && timingSafeEqual(actual, parsed.digest);
  }
}

async function derive(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelization: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_BYTES,
      {
        N: cost,
        r: blockSize,
        p: parallelization,
        maxmem: MAXIMUM_MEMORY_BYTES,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function parseEncodedHash(encodedHash: string): {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  digest: Buffer;
} | null {
  const [algorithm, costValue, blockValue, parallelValue, saltValue, digestValue, extra] =
    encodedHash.split("$");
  if (algorithm !== "scrypt" || !digestValue || extra !== undefined) return null;
  const cost = Number(costValue);
  const blockSize = Number(blockValue);
  const parallelization = Number(parallelValue);
  if (cost !== COST || blockSize !== BLOCK_SIZE || parallelization !== PARALLELIZATION) return null;
  try {
    const salt = Buffer.from(saltValue ?? "", "base64url");
    const digest = Buffer.from(digestValue, "base64url");
    return salt.length === 16 && digest.length === KEY_BYTES
      ? { cost, blockSize, parallelization, salt, digest }
      : null;
  } catch {
    return null;
  }
}
