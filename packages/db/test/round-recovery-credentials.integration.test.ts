import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  CaseSuiteService,
  type CaseSuiteRepository,
  type CaseCatalogRepository,
  type ProjectStructureRepository,
} from "@autoforge/application";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
import { AesGcmSecretCipher } from "../../../apps/web/src/lib/secret-cipher-core";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";

const timestamp = "2026-10-07T00:00:00.000Z";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
type Fixture = {
  suites: CaseSuiteRepository;
  execute: (statement: string, parameters?: string[]) => Promise<void>;
  close: () => Promise<void>;
  rows: (statement: string) => Promise<Record<string, unknown>[]>;
};
async function fixture(mode: "sqlite" | "postgres"): Promise<Fixture> {
  if (mode === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "recovery-credentials-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      suites: new SqliteCaseSuiteRepository(handle),
      execute: async (statement, parameters = []) => {
        handle.client.prepare(statement).run(...parameters);
      },
      rows: async (statement) =>
        handle.client.prepare(statement).all() as Record<string, unknown>[],
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const schema = `recovery_credentials_${randomUUID().replaceAll("-", "")}`;
  const administration = new Pool({ connectionString: postgresUrl!, max: 1 });
  await administration.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(postgresUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    poolMax: 2,
  });
  await handle.ready;
  return {
    suites: new PostgresCaseSuiteRepository(handle),
    execute: async (statement, parameters = []) => {
      let index = 0;
      await handle.pool.query(
        statement.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    },
    rows: async (statement) => (await handle.pool.query<Record<string, unknown>>(statement)).rows,
    close: async () => {
      await handle.close();
      await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      await administration.end();
    },
  };
}
const rule = (id: string) => ({
  id,
  afterRound: 1,
  jenkinsJobUrl: "https://jenkins.internal/job/reset/",
  waitMinutes: 0,
  apiKeyConfigured: true,
});
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 7).toString("base64"));
async function createSuite(context: Fixture, id: string, rules = [rule("stored")]) {
  return context.suites.copySuite({
    id,
    name: `来源任务 ${id}`,
    policy: {
      ...defaultCaseSuiteExecutionPolicy,
      runnerIds: ["runner-1"],
      retryMode: "round",
      retryLimit: 2,
      roundRecoveryRules: rules,
    },
    items: [],
    versionId: randomUUID(),
    createdAt: timestamp,
    roundRecoveryCredentials: Object.fromEntries(
      rules.map((entry) => [
        entry.id,
        cipher.encrypt("user:original-token", `case-suite-round-recovery:${id}:${entry.id}`),
      ]),
    ),
  });
}
function service(suites: CaseSuiteRepository) {
  return new CaseSuiteService(
    suites,
    {} as CaseCatalogRepository,
    {} as ProjectStructureRepository,
    { now: () => new Date(timestamp) },
    { next: randomUUID },
    cipher,
  );
}

for (const mode of ["sqlite", "postgres"] as const)
  describe.skipIf(mode === "postgres" && !postgresUrl)(
    `${mode} reusable recovery credentials`,
    () => {
      it("copies same-task and cross-task keys, strips references from snapshots and survives source removal", async () => {
        const context = await fixture(mode);
        try {
          await createSuite(context, "source");
          const target = await createSuite(context, "target", []);
          const suites = service(context.suites);
          const saved = await suites.update(
            target.id,
            {
              expectedRevision: target.revision,
              policy: {
                roundRecoveryRules: [
                  { ...rule("first"), apiKeySource: { suiteId: "source", ruleId: "stored" } },
                  { ...rule("second"), apiKeySource: { suiteId: "target", ruleId: "first" } },
                ],
              },
            },
            undefined,
            [DEFAULT_PROJECT_ID],
          );
          const credentials = await context.suites.getRoundRecoveryCredentials(target.id, [
            "first",
            "second",
          ]);
          for (const id of ["first", "second"])
            expect(cipher.decrypt(credentials[id]!, `case-suite-round-recovery:target:${id}`)).toBe(
              "user:original-token",
            );
          expect(credentials.first).not.toBe(credentials.second);
          expect(JSON.stringify(saved)).not.toMatch(/original-token|apiKeySource|Ciphertext/);
          const versions = await context.rows(
            "SELECT snapshot_json FROM case_suite_versions WHERE suite_id = 'target'",
          );
          expect(JSON.stringify(versions)).not.toMatch(/original-token|apiKeySource|Ciphertext/);
          await context.execute(
            "DELETE FROM case_suite_round_recovery_credentials WHERE suite_id = 'source'",
          );
          expect(
            cipher.decrypt(
              (await context.suites.getRoundRecoveryCredentials(target.id, ["first"])).first!,
              "case-suite-round-recovery:target:first",
            ),
          ).toBe("user:original-token");
          await expect(
            suites.update(
              target.id,
              {
                expectedRevision: saved.revision,
                policy: {
                  roundRecoveryRules: [
                    { ...rule("first"), apiKeySource: { suiteId: "source", ruleId: "stored" } },
                  ],
                },
              },
              undefined,
              [],
            ),
          ).rejects.toMatchObject({ code: "CASE_SUITE_NOT_FOUND" });
          expect((await context.suites.getSummary(target.id))?.revision).toBe(saved.revision);
        } finally {
          await context.close();
        }
      });

      it("pages metadata without secrets, respects management scope and ignores orphan credentials", async () => {
        const context = await fixture(mode);
        try {
          await createSuite(context, "target", []);
          for (let index = 0; index < 26; index++)
            await createSuite(context, `source-${String(index).padStart(2, "0")}`, [
              rule("a"),
              rule("b"),
            ]);
          await createSuite(context, "literal", [rule("a")]);
          await context.execute(
            "UPDATE case_suites SET name = '任务_%literal' WHERE id = 'literal'",
          );
          await context.execute(
            "INSERT INTO case_suite_round_recovery_credentials (suite_id, rule_id, api_key_ciphertext, updated_at) VALUES ('source-00', 'orphan', 'ignored-ciphertext', ?)",
            [timestamp],
          );
          const suites = service(context.suites);
          const first = await suites.listRoundRecoveryCredentialSources("target", {}, [
            DEFAULT_PROJECT_ID,
          ]);
          expect(first.items).toHaveLength(50);
          const second = await suites.listRoundRecoveryCredentialSources(
            "target",
            { cursor: first.nextCursor! },
            [DEFAULT_PROJECT_ID],
          );
          expect(second.items).toHaveLength(3);
          expect(second.nextCursor).toBeUndefined();
          const all = [...first.items, ...second.items];
          expect(new Set(all.map((entry) => `${entry.suiteId}:${entry.ruleId}`)).size).toBe(53);
          expect(JSON.stringify(all)).not.toMatch(/original-token|ciphertext|orphan/);
          expect(
            (
              await suites.listRoundRecoveryCredentialSources("target", { query: "_%" }, [
                DEFAULT_PROJECT_ID,
              ])
            ).items.map((entry) => entry.suiteId),
          ).toEqual(["literal"]);
          expect(
            await context.suites.listRoundRecoveryCredentialSources({
              excludeSuiteId: "target",
              projectIds: [],
              limit: 50,
            }),
          ).toEqual([]);
          expect(
            await context.suites.listRoundRecoveryCredentialSources({
              excludeSuiteId: "target",
              projectIds: ["other-project"],
              limit: 50,
            }),
          ).toEqual([]);
          await expect(
            suites.listRoundRecoveryCredentialSources("target", { cursor: "bad-json" }, [
              DEFAULT_PROJECT_ID,
            ]),
          ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
        } finally {
          await context.close();
        }
      });
    },
  );
