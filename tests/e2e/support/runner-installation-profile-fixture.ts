import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { AesGcmSecretCipher } from "../../../apps/web/src/lib/secret-cipher-core";

/** Saved SSH metadata exercises the real server-rendered installer without contacting a host. */
export function insertRunnerInstallationProfileFixture(directory: string) {
  const id = randomUUID();
  const host = `${"runner-internal-".repeat(8)}example.test`;
  const name = `安装布局验证-${"长名称执行节点-".repeat(10)}`;
  const fingerprint = `SHA256:${"A".repeat(43)}`;
  const configuration = new PlatformConfigurationStore(directory).initialize();
  const cipher = new AesGcmSecretCipher(configuration.secrets.masterKey);
  const connectionEncrypted = cipher.encrypt(
    JSON.stringify({
      schemaVersion: 1,
      connection: { host, port: 22, username: "installer", password: "Fixture!Password123" },
    }),
    `runner-installation-profile:${id}`,
  );
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database
      .prepare(
        `INSERT INTO runner_installation_profiles
      (id,runner_name,connection_encrypted,expected_host_key_sha256,installation_mode,run_as_root,created_at,updated_at)
      VALUES (?,?,?,?,'auto',0,?,?)`,
      )
      .run(
        id,
        name,
        connectionEncrypted,
        fingerprint,
        new Date().toISOString(),
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
  return {
    id,
    host,
    name,
    fingerprint,
    dispose() {
      const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        database.prepare("DELETE FROM runner_installation_profiles WHERE id=?").run(id);
      } finally {
        database.close();
      }
    },
  };
}
