import { randomUUID } from "node:crypto";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { openHistoryFixtureConnection } from "./history-fixture-connection";
import { AesGcmSecretCipher } from "../../../apps/web/src/lib/secret-cipher-core";

/** Saved SSH metadata exercises the real server-rendered installer without contacting a host. */
export async function insertRunnerInstallationProfileFixture(
  directory = process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR,
) {
  if (!directory)
    throw new Error("Runner installation fixture requires its platform configuration directory.");
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
  const connection = () =>
    openHistoryFixtureConnection({
      directory: process.env.AUTOFORGE_E2E_POSTGRES_URL ? undefined : directory,
      postgresUrl: process.env.AUTOFORGE_E2E_POSTGRES_URL,
    });
  const database = await connection();
  try {
    await database.execute(
      `INSERT INTO runner_installation_profiles
      (id,runner_name,connection_encrypted,expected_host_key_sha256,installation_mode,run_as_root,created_at,updated_at)
      VALUES (?,?,?,?,'auto',FALSE,?,?)`,
      [
        id,
        name,
        connectionEncrypted,
        fingerprint,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  } finally {
    await database.close();
  }
  return {
    id,
    host,
    name,
    fingerprint,
    async dispose() {
      const database = await connection();
      try {
        await database.execute("DELETE FROM runner_installation_profiles WHERE id=?", [id]);
      } finally {
        await database.close();
      }
    },
  };
}
