import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DdtChangeRequestService, DdtCaseService } from "@autoforge/application";
import type { DdtChangeSelection } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID, type DdtCaseData } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteDdtChangeRequestRepository } from "../src/sqlite-ddt-change-requests";
import { PostgresDdtChangeRequestRepository } from "../src/postgres-ddt-change-requests";
import { SqliteDdtDebugRepository } from "../src/sqlite-ddt-debug";
import { PostgresDdtDebugRepository } from "../src/postgres-ddt-debug";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { PostgresDdtRepository } from "../src/postgres-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";
import { SqliteWriterContention } from "./sqlite-writer-contention";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} DDT change review`,
    () => {
      it("merges only selected fields, preserves private edits and records immutable review/history", async () => {
        const f = await fixture(dialect);
        try {
          await f.personal("CASE-1", { CaseName: "new title", account: "private account" });
          const selected = await f.selection("CASE-1");
          const request = await f.submit([{ ...selected, fields: ["CaseName"] }]);
          expect((await f.formal.getCase(f.scope, "CASE-1"))!.data.CaseName).toBe("original");
          await f.personal("CASE-1", { CaseName: "later personal edit", account: "later account" });
          const approved = await f.service.review(f.scope, request.id, f.reviewer, true, {
            action: "approve",
            comment: "validated",
          });
          expect(approved).toMatchObject({
            status: "approved",
            reviewerId: f.reviewer,
            reviewComment: "validated",
          });
          expect(approved.items[0]!.after.CaseName).toBe("new title");
          expect((await f.formal.getCase(f.scope, "CASE-1"))!.data).toMatchObject({
            CaseName: "new title",
            account: "shared account",
          });
          expect((await f.debug.get(f.personalScope, "CASE-1"))!.data.account).toBe(
            "later account",
          );
          const history = await f.formal.listHistory({ ...f.scope, caseId: "CASE-1", limit: 20 });
          expect(history.items).toHaveLength(1);
          expect(history.items[0]).toMatchObject({
            actorId: f.reviewer,
            before: { CaseName: "original" },
            after: { CaseName: "new title" },
          });
          await f.service.review(f.scope, request.id, f.reviewer, true, {
            action: "approve",
            comment: "retry",
          });
          expect((await f.formal.getCase(f.scope, "CASE-1"))!.revision).toBe(2);
        } finally {
          await f.close();
        }
      });

      it("inserts new cases, rejects stale preview and does not submit unchanged cases", async () => {
        const f = await fixture(dialect);
        try {
          await f.personal("NEW-1", { CaseName: "new" });
          const original = await f.selection("NEW-1");
          await f.personal("NEW-1", { CaseName: "changed after preview" });
          await expect(f.submit([original])).rejects.toMatchObject({
            code: "DDT_CHANGE_PREVIEW_CONFLICT",
          });
          const request = await f.submit([await f.selection("NEW-1")]);
          await f.service.review(f.scope, request.id, f.reviewer, true, {
            action: "approve",
            comment: "",
          });
          expect((await f.formal.getCase(f.scope, "NEW-1"))!.revision).toBe(1);
          expect(
            (await f.service.candidates(f.personalScope, { query: "", limit: 20 })).items,
          ).toHaveLength(0);
          await expect(f.submit([await f.selection("NEW-1")])).rejects.toMatchObject({
            code: "DDT_CHANGE_EMPTY",
          });
        } finally {
          await f.close();
        }
      });

      it("rolls back the entire merge if any formal revision changed, including earlier inserts", async () => {
        const f = await fixture(dialect);
        try {
          await f.personal("NEW-1", { CaseName: "new" });
          await f.personal("CASE-1", { CaseName: "proposed" });
          const request = await f.submit([await f.selection("NEW-1"), await f.selection("CASE-1")]);
          const before = (await f.formal.getCase(f.scope, "CASE-1"))!;
          await f.cases.update(
            f.scope,
            "CASE-1",
            before.revision,
            { ...before.data, CaseName: "another writer" },
            f.reviewer,
          );
          await expect(
            f.service.review(f.scope, request.id, f.reviewer, true, {
              action: "approve",
              comment: "",
            }),
          ).rejects.toMatchObject({ code: "DDT_CHANGE_REQUEST_CONFLICT" });
          expect(await f.formal.getCase(f.scope, "NEW-1")).toBeNull();
          expect((await f.formal.getCase(f.scope, "CASE-1"))!.data.CaseName).toBe("another writer");
          expect((await f.service.get(f.scope, request.id, f.owner, false)).status).toBe("pending");
        } finally {
          await f.close();
        }
      });

      it("prevents duplicate inserts and merges under concurrent approvals", async () => {
        const f = await fixture(dialect);
        try {
          await f.personal("NEW-1", { CaseName: "new" });
          const a = await f.submit([await f.selection("NEW-1")]);
          const b = await f.submit([await f.selection("NEW-1")]);
          const outcomes = await Promise.allSettled(
            [a, b].map((request) =>
              f.service.review(f.scope, request.id, f.reviewer, true, {
                action: "approve",
                comment: "",
              }),
            ),
          );
          expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          expect((await f.formal.getCase(f.scope, "NEW-1"))!.revision).toBe(1);
          expect(
            (await f.formal.listHistory({ ...f.scope, caseId: "NEW-1", limit: 20 })).items,
          ).toHaveLength(1);
        } finally {
          await f.close();
        }
      });

      it("isolates authors/scopes, rejects unauthorized review, and makes reject/withdraw final", async () => {
        const f = await fixture(dialect);
        try {
          await f.personal("CASE-1", { CaseName: "proposed" });
          const request = await f.submit([await f.selection("CASE-1")]);
          await expect(f.service.get(f.scope, request.id, f.reviewer, false)).rejects.toMatchObject(
            { code: "DDT_CHANGE_REQUEST_NOT_FOUND" },
          );
          await expect(
            f.service.get({ ...f.scope, testStageId: randomUUID() }, request.id, f.reviewer, true),
          ).rejects.toMatchObject({ code: "DDT_CHANGE_REQUEST_NOT_FOUND" });
          await expect(
            f.service.review(f.scope, request.id, f.owner, false, {
              action: "approve",
              comment: "",
            }),
          ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
          await expect(
            f.service.review(f.scope, request.id, f.reviewer, true, {
              action: "withdraw",
              comment: "",
            }),
          ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
          await expect(
            f.service.review(f.scope, request.id, f.reviewer, true, {
              action: "reject",
              comment: "",
            }),
          ).rejects.toMatchObject({ code: "DDT_CHANGE_REASON_REQUIRED" });
          await f.service.review(f.scope, request.id, f.reviewer, true, {
            action: "reject",
            comment: "keep account private",
          });
          await expect(
            f.service.review(f.scope, request.id, f.reviewer, true, {
              action: "approve",
              comment: "",
            }),
          ).rejects.toMatchObject({ code: "DDT_CHANGE_REQUEST_CONFLICT" });
          const next = await f.submit([await f.selection("CASE-1")]);
          await f.service.review(f.scope, next.id, f.owner, false, {
            action: "withdraw",
            comment: "",
          });
          expect((await f.formal.getCase(f.scope, "CASE-1"))!.revision).toBe(1);
          expect(
            (await f.service.list(f.scope, { ownerUserId: f.reviewer, limit: 20 })).items,
          ).toHaveLength(0);
          const firstPage = await f.service.list(f.scope, { ownerUserId: f.owner, limit: 1 });
          expect(firstPage.nextCursor).toBeDefined();
          const nextPage = await f.service.list(f.scope, {
            ownerUserId: f.owner,
            limit: 1,
            cursor: firstPage.nextCursor!,
          });
          expect(nextPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
          expect(nextPage.nextCursor).toBeUndefined();
        } finally {
          await f.close();
        }
      });

      it("recovers short writer contention and handles repeat submission without duplicating history", async () => {
        const f = await fixture(dialect, true);
        try {
          await f.personal("CASE-1", { CaseName: "proposed" });
          const selection = await f.selection("CASE-1");
          const id = randomUUID();
          await f.submit([selection], id);
          await f.submit([selection], id);
          expect((await f.service.list(f.scope, { limit: 20 })).items).toHaveLength(1);
          await f.service.review(f.scope, id, f.reviewer, true, { action: "approve", comment: "" });
          expect((await f.formal.getCase(f.scope, "CASE-1"))!.revision).toBe(2);
        } finally {
          await f.close();
        }
      });
    },
  );
}

async function fixture(dialect: "sqlite" | "postgres", contention = false) {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-review-"));
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "db.sqlite"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
        })
      : undefined;
  const postgres =
    dialect === "postgres"
      ? createPostgresDatabase({
          connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
          migrationsFolder: resolve("packages/db/drizzle/postgresql"),
        })
      : undefined;
  await postgres?.ready;
  async function sql(statement: string, values: (string | number)[]) {
    if (sqlite) sqlite.client.prepare(statement).run(...values);
    else {
      let index = 0;
      await postgres!.pool.query(
        statement.replace(/\?/gu, () => `$${++index}`),
        values,
      );
    }
  }
  const now = "2026-09-29T12:00:00.000Z";
  const owner = randomUUID(),
    reviewer = randomUUID();
  for (const id of [owner, reviewer])
    await sql(
      "INSERT INTO users (id, username, normalized_username, display_name, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)",
      [id, id, id, id, now, now],
    );
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: randomUUID(),
    testStageId: randomUUID(),
  };
  const structures = sqlite
    ? new SqliteProjectStructureRepository(sqlite)
    : new PostgresProjectStructureRepository(postgres!);
  await structures.createVersion({
    id: scope.projectVersionId,
    projectId: scope.projectId,
    name: scope.projectVersionId,
    normalizedName: scope.projectVersionId,
    recordedAt: now,
  });
  await structures.createStage({
    ...scope,
    id: scope.testStageId,
    name: "SIT",
    normalizedName: "sit",
    description: "",
    recordedAt: now,
  });
  await sql(
    `INSERT INTO ddt_cases (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized, sr_num, sr_num_normalized, case_kind, data_json, source_name, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'CASE-1', 'case-1', 'SR', 'sr', 'standard', ?, 'fixture', 1, ?, ?)`,
    [
      randomUUID(),
      scope.projectId,
      scope.projectVersionId,
      scope.testStageId,
      JSON.stringify({
        CaseID: "CASE-1",
        srNum: "SR",
        CaseName: "original",
        account: "shared account",
      }),
      now,
      now,
    ],
  );
  const repository = sqlite
    ? new SqliteDdtChangeRequestRepository(sqlite)
    : new PostgresDdtChangeRequestRepository(postgres!);
  const formal = sqlite ? new SqliteDdtRepository(sqlite) : new PostgresDdtRepository(postgres!);
  const debug = sqlite
    ? new SqliteDdtDebugRepository(sqlite)
    : new PostgresDdtDebugRepository(postgres!);
  const writer = sqlite && contention ? new SqliteWriterContention(sqlite) : undefined;
  const service = new DdtChangeRequestService(
    writer ? writer.wrap(repository) : repository,
    debug,
    formal,
    { now: () => new Date(now) },
    { next: randomUUID },
  );
  const personalScope = { ...scope, ownerUserId: owner };
  const selection = async (caseId: string): Promise<DdtChangeSelection> => {
    const item = await service.compare(personalScope, caseId);
    return {
      caseId,
      personalRevision: item.personalRevision,
      baseId: item.baseId,
      baseRevision: item.baseRevision,
    };
  };
  return {
    scope,
    personalScope,
    owner,
    reviewer,
    service,
    formal,
    debug,
    cases: new DdtCaseService(formal, { now: () => new Date(now) }, { next: randomUUID }),
    selection,
    personal: (caseId: string, fields: DdtCaseData) =>
      debug.write({
        scope: personalScope,
        id: randomUUID(),
        caseId,
        data: { CaseID: caseId, srNum: "SR", ...fields },
        sourceName: "personal",
        now,
        strategy: "overwrite",
      }),
    submit: (cases: DdtChangeSelection[], id = randomUUID()) =>
      service.submit(personalScope, {
        id,
        title: "Reviewed test data",
        description: "Only chosen differences",
        cases,
      }),
    close: async () => {
      await writer?.close();
      sqlite?.close();
      await postgres?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
