import "server-only";

import { ImportTestNgJarService } from "@autoforge/application";
import { createSqliteDatabase, SqliteCaseCatalogRepository } from "@autoforge/db";
import { LocalObjectStore } from "@autoforge/object-store";
import { TestNgJarDiscovery } from "@autoforge/testng-discovery";

import { loadAppConfig } from "./config";
import { uuidV7 } from "./uuid-v7";

export type PlatformServices = ReturnType<typeof createPlatformServices>;

function createPlatformServices() {
  const config = loadAppConfig();
  const database = createSqliteDatabase({
    databasePath: config.databasePath,
    migrationsFolder: config.migrationsFolder,
  });
  const catalog = new SqliteCaseCatalogRepository(database);
  const discovery = new TestNgJarDiscovery({ maxJarBytes: config.maxJarBytes });
  const objectStore = new LocalObjectStore(config.dataDirectory);
  const importTestNgJar = new ImportTestNgJarService({
    discovery,
    objectStore,
    catalog,
    clock: { now: () => new Date() },
    ids: { next: () => uuidV7() },
  });

  return {
    config,
    database,
    catalog,
    discovery,
    objectStore,
    importTestNgJar,
  };
}

const globalServices = globalThis as typeof globalThis & {
  __autoforgePlatformServices?: PlatformServices;
};

export function getPlatformServices(): PlatformServices {
  globalServices.__autoforgePlatformServices ??= createPlatformServices();
  return globalServices.__autoforgePlatformServices;
}
