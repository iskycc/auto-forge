import { loadAppConfig } from "../src/lib/config.ts";
import { migratePostgresDatabase, migrateSqliteDatabase } from "../src/lib/migrate-database.ts";

const config = loadAppConfig();

if (config.mode === "lite") {
  migrateSqliteDatabase(config.databasePath, config.migrationsFolder);
} else {
  await migratePostgresDatabase(config.databaseUrl, config.migrationsFolder);
}

process.stdout.write(
  `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    message: "AutoForge database migrations completed",
    mode: config.mode,
    configurationRevision: config.configurationRevision,
  })}\n`,
);
