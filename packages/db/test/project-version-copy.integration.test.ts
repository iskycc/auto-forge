import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { SqliteProjectVersionCopyRepository } from "../src/sqlite-version-copy";
import type { VersionCopyRow } from "@autoforge/application";

import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { vi } from "vitest";
import {
  ProjectVersionCopyService,
  ProjectVersionCopyRequests,
  versionCopyId,
  versionCopyObjectKey,
} from "@autoforge/application";
import { roundRecoverySecretPurpose } from "../../application/src/round-recovery-credentials";
import { LocalObjectStore } from "../../object-store/src/local-object-store";
import { AesGcmSecretCipher } from "../../../apps/web/src/lib/secret-cipher-core";
import { createAttemptLogStore } from "../src/attempt-log-store";
import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresLogDatabaseRepository } from "../src/postgres-log-databases";
import { PostgresRoutedAttemptLogStore } from "../src/postgres-routed-attempt-logs";
import { PostgresProjectVersionCopyRepository } from "../src/postgres-version-copy";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";
import { SqlitePublicExecutionAccessRepository } from "../src/sqlite-public-execution-access";
import { PostgresPublicExecutionAccessRepository } from "../src/postgres-public-execution-access";
import { VersionCopyArchive } from "../src/version-copy-archive";

const now = "2026-10-23T00:00:00.000Z";
const batchId = "019a1280-0000-7000-8000-000000000010";
const attemptId = "original-attempt";
const input = {
  sourceProjectId: "source",
  sourceVersionId: "version",
  targetProjectId: "target",
  targetVersionName: "版本副本",
  requestKey: "request",
};
const data = {
  CaseID: "钱包-支付中文",
  CaseName: "中文名称",
  SRID: "001",
  id: "case",
  projectId: "source",
  objectKey: "用户字段不能改写",
  value: false,
};
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !postgresUrl)(
    `${dialect} complete version copy`,
    () => {
      it("copies independent SR tags with remapped identities and assignments", async () => {
        const f = await fixture(dialect);
        try {
          await f.rows(
            "INSERT INTO ddt_sr_tags(id,project_id,project_version_id,name,normalized_name,created_at) VALUES ('sr-tag','source','version','Wallet','wallet',?)",
            [now],
          );
          await f.rows(
            "INSERT INTO ddt_sr_tag_assignments(tag_id,project_id,project_version_id,sr_num_normalized,created_at) VALUES ('sr-tag','source','version','sr',?)",
            [now],
          );
          const job = await f.requests.create(input, "operator");
          await f.service.execute(job.id, new AbortController().signal);
          const state = (await f.repository.get(job.id))!;
          expect(
            await f.rows(
              "SELECT tag_id,sr_num_normalized FROM ddt_sr_tag_assignments WHERE project_version_id=?",
              [state.targetVersionId],
            ),
          ).toEqual([{ tag_id: versionCopyId(state, "sr-tag"), sr_num_normalized: "sr" }]);
          expect(
            await f.rows("SELECT name FROM ddt_sr_tags WHERE id=?", [
              versionCopyId(state, "sr-tag"),
            ]),
          ).toEqual([{ name: "Wallet" }]);
        } finally {
          await f.close();
        }
      }, 60000);
      it("rejects a tags-only target as an empty-version copy destination", async () => {
        const f = await fixture(dialect);
        try {
          await f.structures.createVersion({
            id: "tags-only",
            projectId: "target",
            name: "标签版本",
            normalizedName: "标签版本",
            recordedAt: now,
          });
          await f.rows(
            "INSERT INTO ddt_sr_tags(id,project_id,project_version_id,name,normalized_name,created_at) VALUES ('tag-only','target','tags-only','Wallet','wallet',?)",
            [now],
          );
          expect(
            (await f.repository.listTargets("target")).items.find(
              (version) => version.id === "tags-only",
            )?.empty,
          ).toBe(false);
          await expect(
            f.requests.create(
              { ...input, targetVersionName: undefined, targetVersionId: "tags-only" },
              "operator",
            ),
          ).rejects.toMatchObject({ code: "VERSION_COPY_TARGET_NOT_EMPTY" });
        } finally {
          await f.close();
        }
      }, 60000);
      it.each(["source", "target"])(
        "copies into an existing empty version in project %s while preserving its identity and metadata",
        async (targetProjectId) => {
          const f = await fixture(dialect);
          try {
            const target = await f.structures.createVersion({
              id: "existing",
              projectId: targetProjectId,
              name: "原有空版本",
              normalizedName: "原有空版本",
              recordedAt: now,
            });
            const before = await f.rows("SELECT * FROM project_versions WHERE id=?", [target.id]);
            const existingInput = {
              ...input,
              targetProjectId,
              targetVersionName: undefined,
              targetVersionId: target.id,
            };
            expect(
              (await f.repository.listTargets(targetProjectId)).items.filter(
                (version) => version.id === target.id,
              ),
            ).toMatchObject([{ id: target.id, empty: true }]);
            const job = await f.requests.create(existingInput, "operator");
            expect(job.targetMode).toBe("existing");
            expect(job.targetVersionName).toBe(target.name);
            expect(await f.requests.create(existingInput, "operator")).toEqual(job);
            await expect(
              f.requests.create({ ...input, targetProjectId }, "operator"),
            ).rejects.toMatchObject({
              code: "VERSION_COPY_REQUEST_CONFLICT",
            });
            expect(
              (await f.structures.list(targetProjectId)).versions.some(
                (version) => version.id === target.id,
              ),
            ).toBe(false);
            await f.service.execute(job.id, new AbortController().signal);
            expect((await f.repository.get(job.id))?.status).toBe("completed");
            expect(await f.rows("SELECT * FROM project_versions WHERE id=?", [target.id])).toEqual(
              before,
            );
            const result = (await f.structures.list(targetProjectId)).versions.filter(
              (version) => version.id === target.id,
            );
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
              id: target.id,
              name: target.name,
              stages: [{ name: "SIT" }],
            });
            expect(
              (await f.repository.listTargets(targetProjectId)).items.filter(
                (version) => version.id === target.id,
              )[0]?.empty,
            ).toBe(false);
            expect(
              Number(
                (
                  await f.rows(
                    "SELECT COUNT(*) AS count FROM ddt_cases WHERE project_version_id=?",
                    [target.id],
                  )
                )[0]?.count,
              ),
            ).toBe(70);
          } finally {
            await f.close();
          }
        },
        60000,
      );
      it("rejects nonempty, foreign and identical targets, including versions containing only historical records or runtime configuration", async () => {
        const f = await fixture(dialect);
        try {
          await f.structures.createVersion({
            id: "existing",
            projectId: "target",
            name: "非空目标",
            normalizedName: "非空目标",
            recordedAt: now,
          });
          const existingInput = {
            ...input,
            targetVersionName: undefined,
            targetVersionId: "existing",
          };
          const rejectNonempty = async () => {
            expect((await f.repository.listTargets("target")).items[0]?.empty).toBe(false);
            await expect(f.requests.create(existingInput, "operator")).rejects.toMatchObject({
              code: "VERSION_COPY_TARGET_NOT_EMPTY",
            });
            expect(await f.rows("SELECT id FROM project_version_copies")).toEqual([]);
          };
          await f.structures.createStage({
            id: "target-stage",
            projectId: "target",
            projectVersionId: "existing",
            name: "空阶段",
            normalizedName: "空阶段",
            description: "",
            recordedAt: now,
          });
          await rejectNonempty();
          await f.rows("DELETE FROM test_stages WHERE id='target-stage'");
          await f.rows(
            "INSERT INTO run_batches(id,project_id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,policy_json,sequence_number,created_at,updated_at) SELECT 'target-history','target',suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,?,12,?,? FROM run_batches WHERE id='019a1280-0000-7000-8000-000000000010'",
            [JSON.stringify({ projectVersionId: "existing" }), now, now],
          );
          await rejectNonempty();
          await f.rows("DELETE FROM run_batches WHERE id='target-history'");
          await f.rows(
            "INSERT INTO case_suites(id,project_id,name,version,description,policy_json,created_at,updated_at) SELECT 'target-task','target','历史任务',version,'',?,created_at,updated_at FROM case_suites WHERE id='suite'",
            [JSON.stringify({ projectVersionId: "existing" })],
          );
          await rejectNonempty();
          await f.rows("DELETE FROM case_suites WHERE id='target-task'");
          await f.rows(
            "INSERT INTO project_runtime_assets(id,project_id,kind,source_type,file_name,url,sha256,size_bytes,archive_format,created_at) VALUES ('target-asset','target','jdk','url','jdk.tar.gz','http://internal/jdk','checksum',1,'tar.gz',?)",
            [now],
          );
          await f.rows(
            "INSERT INTO project_version_runtime_assets(project_id,project_version_id,jdk_asset_id,updated_at) VALUES ('target','existing','target-asset',?)",
            [now],
          );
          await rejectNonempty();
          await expect(
            f.requests.create({ ...existingInput, targetVersionId: "version" }, "operator"),
          ).rejects.toMatchObject({ code: "VERSION_COPY_TARGET_INVALID" });
          await expect(
            f.requests.create({ ...existingInput, targetProjectId: "source" }, "operator"),
          ).rejects.toMatchObject({ code: "VERSION_COPY_TARGET_INVALID" });
        } finally {
          await f.close();
        }
      }, 60000);
      it("blocks competing stage and configuration writes, preserves an existing version after partial cancellation and permits another copy", async () => {
        const f = await fixture(dialect);
        try {
          await f.structures.createVersion({
            id: "existing",
            projectId: "target",
            name: "保留版本",
            normalizedName: "保留版本",
            recordedAt: now,
          });
          await f.rows(
            "UPDATE project_versions SET status='archived',revision=9 WHERE id='existing'",
          );
          const before = await f.rows("SELECT * FROM project_versions WHERE id='existing'");
          const existingInput = {
            ...input,
            targetVersionName: undefined,
            targetVersionId: "existing",
          };
          const job = await f.requests.create(existingInput, "operator");
          const stage = {
            id: "competing",
            projectId: "target",
            projectVersionId: "existing",
            name: "竞争阶段",
            normalizedName: "竞争阶段",
            description: "",
            recordedAt: now,
          };
          await expect(f.structures.createStage(stage)).rejects.toMatchObject({
            code: "VERSION_COPY_TARGET_RESERVED",
          });
          await expect(
            f.structures.updateAdapterConfiguration({
              projectId: "target",
              projectVersionId: "existing",
              expectedRevision: 0,
              updatedAt: now,
            }),
          ).rejects.toMatchObject({ code: "VERSION_COPY_TARGET_RESERVED" });
          expect((await f.repository.listTargets("target")).items).toEqual([]);
          const insert = f.repository.insertPage.bind(f.repository);
          let cancelled = false;
          vi.spyOn(f.repository, "insertPage").mockImplementation(async (state, records, token) => {
            await insert(state, records, token);
            if (!cancelled && records[0]?.collection === "ddt_cases") {
              cancelled = true;
              await f.requests.action(job.id, "cancel", "operator");
            }
          });
          vi.spyOn(f.repository, "removeTarget").mockRejectedValueOnce(
            new Error("cleanup final write failed"),
          );
          await expect(
            f.service.execute(job.id, new AbortController().signal),
          ).rejects.toMatchObject({ code: "VERSION_COPY_CLEANUP_FAILED" });
          expect((await f.structures.list("target")).versions).toEqual([]);
          await f.requests.action(job.id, "retry", "operator");
          await f.service.execute(job.id, new AbortController().signal);
          expect((await f.repository.get(job.id))?.status).toBe("cancelled");
          expect(await f.rows("SELECT * FROM project_versions WHERE id='existing'")).toEqual(
            before,
          );
          expect((await f.structures.list("target")).versions).toMatchObject([
            { id: "existing", status: "archived", revision: 9, stages: [] },
          ]);
          expect((await f.repository.listTargets("target")).items[0]?.empty).toBe(true);
          expect(await f.rows("SELECT id FROM ddt_cases WHERE project_id='target'")).toEqual([]);
          const next = await f.requests.create(
            { ...existingInput, requestKey: "second-copy" },
            "operator",
          );
          await f.requests.action(next.id, "cancel", "operator");
          await f.service.execute(next.id, new AbortController().signal);
          expect(await f.rows("SELECT * FROM project_versions WHERE id='existing'")).toEqual(
            before,
          );
          await f.structures.createStage(stage);
          expect((await f.repository.listTargets("target")).items[0]?.empty).toBe(false);
        } finally {
          await f.close();
        }
      }, 60000);
      it("paginates target version choices without returning a whole project inventory", async () => {
        const f = await fixture(dialect);
        try {
          for (let index = 0; index < 21; index++)
            await f.structures.createVersion({
              id: `empty-${index.toString().padStart(2, "0")}`,
              projectId: "target",
              name: `空版本${index}`,
              normalizedName: `空版本${index}`,
              recordedAt: now,
            });
          const first = await f.repository.listTargets("target");
          expect(first.items).toHaveLength(20);
          expect(first.items.every((item) => item.empty)).toBe(true);
          const last = await f.repository.listTargets("target", first.nextCursor);
          expect(last.items.map((item) => item.id)).toEqual(["empty-20"]);
          expect(last.nextCursor).toBeUndefined();
        } finally {
          await f.close();
        }
      }, 60000);
      it("allows an authorized administrator to clean up after the original requester is revoked", async () => {
        const f = await fixture(dialect);
        try {
          const job = await f.requests.create(input, "operator");
          f.authorize.mockRejectedValue(new Error("requester revoked"));
          await expect(
            f.service.execute(job.id, new AbortController().signal),
          ).rejects.toMatchObject({ code: "VERSION_COPY_FAILED" });
          f.authorize.mockResolvedValueOnce(undefined);
          await f.requests.action(job.id, "cancel", "administrator");
          await f.service.execute(job.id, new AbortController().signal);
          expect((await f.repository.get(job.id))?.status).toBe("cancelled");
        } finally {
          await f.close();
        }
      }, 60000);
      it("fences expired or replaced worker leases before accepting progress", async () => {
        const f = await fixture(dialect);
        try {
          const job = await f.requests.create(input, "operator");
          const state = (await f.repository.claim(
            job.id,
            "owner",
            now,
            "2026-10-23T00:01:00.000Z",
          ))!;
          await f.rows(
            "UPDATE project_version_copies SET lease_expires_at='2026-10-22T00:00:00.000Z' WHERE id=?",
            [job.id],
          );
          await expect(f.repository.save(state, "owner")).rejects.toMatchObject({
            code: "VERSION_COPY_LEASE_LOST",
          });
          expect(await f.repository.renew(job.id, "owner", now, "2026-10-23T00:02:00.000Z")).toBe(
            false,
          );
          expect(
            await f.repository.claim(job.id, "replacement", now, "2026-10-23T00:02:00.000Z"),
          ).not.toBeNull();
          await expect(f.repository.save(state, "owner")).rejects.toMatchObject({
            code: "VERSION_COPY_LEASE_LOST",
          });
        } finally {
          await f.close();
        }
      }, 60000);
      it.skipIf(process.env.AUTOFORGE_TEST_VERSION_COPY_SCALE !== "1")(
        "copies 100,000 task members without loading their whole collection into a request",
        async () => {
          const f = await fixture(dialect);
          try {
            await f.rows(
              `WITH RECURSIVE numbers(n) AS (SELECT 70 UNION ALL SELECT n+1 FROM numbers WHERE n<99999)
            INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at)
            SELECT 'ddt-'||n,'source','version','stage','钱包-'||n,'钱包-'||n,'SR','sr','standard','{}',?,? FROM numbers`,
              [now, now],
            );
            await f.rows(
              `INSERT INTO case_suite_ddt_items(id,suite_id,ddt_case_id,added_at) SELECT 'bulk-member-'||id,'suite',id,? FROM ddt_cases WHERE id<>'ddt-0'`,
              [now],
            );
            await f.rows("UPDATE case_suite_versions SET snapshot_json=?", [
              JSON.stringify({
                name: "混合任务",
                policy: { projectVersionId: "version" },
                caseDefinitionIds: ["case"],
                ddtCaseIds: Array.from({ length: 100000 }, (_, index) => `ddt-${index}`),
              }),
            ]);
            const job = await f.requests.create(input, "operator");
            await f.service.execute(job.id, new AbortController().signal);
            const state = (await f.repository.get(job.id))!;
            expect(state.status).toBe("completed");
            expect(state.copiedRows).toBe(state.totalRows);
            expect(
              Number(
                (
                  await f.rows(
                    "SELECT COUNT(*) AS count FROM case_suite_ddt_items WHERE suite_id=?",
                    [versionCopyId(state, "suite")],
                  )
                )[0]?.count,
              ),
            ).toBe(100000);
          } finally {
            await f.close();
          }
        },
        180000,
      );
      it("refuses an incomplete log and can resume after its missing chunks arrive", async () => {
        const f = await fixture(dialect);
        try {
          await f.rows(
            "UPDATE attempt_log_watermarks SET acknowledged_sequence=65 WHERE attempt_id=?",
            [attemptId],
          );
          const job = await f.requests.create(input, "operator");
          await expect(
            f.service.execute(job.id, new AbortController().signal),
          ).rejects.toMatchObject({ code: "VERSION_COPY_LOG_INCOMPLETE" });
          expect((await f.structures.list("target")).versions).toEqual([]);
          await f.logs.appendChunks({
            batchId,
            attemptId,
            receivedAt: now,
            chunks: [{ stream: "stdout", sequence: 65, content: "补齐的日志", recordedAt: now }],
          });
          await f.requests.action(job.id, "retry", "operator");
          await f.service.execute(job.id, new AbortController().signal);
          expect((await f.repository.get(job.id))?.status).toBe("completed");
        } finally {
          await f.close();
        }
      }, 60000);
      it("copies independent cases, DDT history, tasks, credentials, execution logs, attachments and analysis without publishing partial data", async () => {
        const f = await fixture(dialect);
        try {
          await f.rows(
            "INSERT INTO run_batches(id,project_id,suite_id,suite_name,suite_version,status,retry_limit,total_runs,environment_json,policy_json,sequence_number,created_at,updated_at) SELECT '019a1280-0000-7000-8000-000000000011',project_id,suite_id,suite_name,suite_version,status,retry_limit,1,environment_json,policy_json,11,created_at,updated_at FROM run_batches WHERE id=?",
            [batchId],
          );
          const job = await f.requests.create(input, "operator");
          expect(await f.requests.create(input, "operator")).toEqual(job);
          expect((await f.structures.list("target")).versions).toEqual([]);
          expect(
            await f.rows(
              dialect === "sqlite"
                ? "SELECT kind FROM queue_jobs"
                : "SELECT payload_json::text AS payload FROM transactional_outbox",
            ),
          ).toHaveLength(1);
          const pages = vi.spyOn(f.repository, "insertPage");
          const finish = f.repository.finish.bind(f.repository);
          vi.spyOn(f.repository, "finish").mockImplementationOnce(
            async (state, manifest, token) => {
              expect((await f.structures.list("target")).versions).toEqual([]);
              expect(await f.publicAccess.isBatchPublic(versionCopyId(state, batchId))).toBe(false);
              expect(await f.publicAccess.isAttemptPublic(versionCopyId(state, attemptId))).toBe(
                false,
              );
              return finish(state, manifest, token);
            },
          );
          await f.service.execute(job.id, new AbortController().signal);
          const completed = await f.repository.get(job.id);
          expect(completed).toMatchObject({
            status: "completed",
            progressPercent: 100,
            copiedAttempts: 1,
            copiedObjects: 3,
          });
          expect(completed!.copiedRows).toBe(completed!.totalRows);
          expect(pages.mock.calls.every(([, page]) => page.length <= 32)).toBe(true);
          const state = completed!;
          const mapped = (id: string) => versionCopyId(state, id);
          const target = (await f.structures.list("target")).versions[0]!;
          expect(target).toMatchObject({
            id: state.targetVersionId,
            name: "版本副本",
            stages: [{ id: mapped("stage") }],
          });
          expect(await f.publicAccess.isBatchPublic(mapped(batchId))).toBe(true);
          expect(await f.publicAccess.isAttemptPublic(mapped(attemptId))).toBe(true);
          expect(
            (await f.rows("SELECT data_json FROM ddt_cases WHERE id=?", [mapped("ddt-0")]))[0]
              ?.data_json,
          ).toBe(JSON.stringify(data));
          expect(
            (
              await f.rows("SELECT before_json FROM ddt_case_history WHERE id=?", [
                mapped("ddt-history"),
              ])
            )[0]?.before_json,
          ).toBe(JSON.stringify(data));
          const suite = (
            await f.rows("SELECT * FROM case_suites WHERE id=?", [mapped("suite")])
          )[0]!;
          expect(Boolean(suite.enabled)).toBe(false);
          const policy = JSON.parse(String(suite.policy_json)) as {
            projectVersionId: string;
            runnerId: string;
          };
          expect(policy).toMatchObject({
            projectVersionId: state.targetVersionId,
            runnerId: "runner",
          });
          expect(
            (
              await f.rows("SELECT enabled FROM case_suite_schedules WHERE id=?", [
                mapped("schedule"),
              ])
            )[0]?.enabled,
          ).toBe(dialect === "sqlite" ? 0 : false);
          const credential = (
            await f.rows(
              "SELECT api_key_ciphertext FROM case_suite_round_recovery_credentials WHERE suite_id=?",
              [mapped("suite")],
            )
          )[0]!;
          expect(
            f.cipher.decrypt(
              String(credential.api_key_ciphertext),
              roundRecoverySecretPurpose(mapped("suite"), mapped("rule")),
            ),
          ).toBe("jenkins-secret");
          expect(() =>
            f.cipher.decrypt(
              String(credential.api_key_ciphertext),
              roundRecoverySecretPurpose("suite", "rule"),
            ),
          ).toThrow();
          const analysis = (
            await f.rows("SELECT * FROM failure_analysis_claims WHERE id=?", [mapped("analysis")])
          )[0]!;
          expect(analysis).toMatchObject({
            batch_id: mapped(batchId),
            execution_run_id: mapped("run"),
            attempt_id: mapped(attemptId),
            claimant_id: "operator",
            remark: "保留分析结论",
          });
          const copiedBatch = (
            await f.rows("SELECT sequence_number FROM run_batches WHERE id=?", [mapped(batchId)])
          )[0]!;
          expect(Number(copiedBatch.sequence_number)).not.toBe(10);
          const sequences = await f.rows(
            "SELECT sequence_number FROM run_batches WHERE project_id='target'",
          );
          expect(new Set(sequences.map((row) => Number(row.sequence_number))).size).toBe(2);
          const actual = await f.logs.listChunks({
            batchId: mapped(batchId),
            attemptId: mapped(attemptId),
            stream: "stdout",
            afterSequence: -1,
            limit: 100,
          });
          expect(actual.items[0]?.content).toBe("首条中文日志");
          expect(
            await f.logs.acknowledgedSequence(mapped(batchId), mapped(attemptId), "stdout"),
          ).toBe(64);
          for (const object of f.objectsToSeed) {
            await f.objects.delete(object.objectKey);
            expect(
              Buffer.from(
                await f.objects.read(versionCopyObjectKey(state, object.objectKey)),
              ).toString(),
            ).toBe(object.content);
          }
          await f.logs.removeBatchStore(batchId);
          expect(
            (
              await f.logs.listChunks({
                batchId: mapped(batchId),
                attemptId: mapped(attemptId),
                stream: "stdout",
                afterSequence: -1,
                limit: 1,
              })
            ).items[0]?.content,
          ).toBe("首条中文日志");
          expect(
            (
              await f.rows(
                "SELECT COUNT(*) AS count FROM ddt_cases WHERE project_version_id='version'",
              )
            )[0]?.count,
          ).toBe(dialect === "sqlite" ? 70 : "70");
          expect(
            (await f.rows("SELECT project_id FROM run_batches WHERE id=?", [batchId]))[0]
              ?.project_id,
          ).toBe("source");
        } finally {
          await f.close();
        }
      }, 60000);

      it("refuses live sources, retries after they end, and cancels a partial copy without deleting source data", async () => {
        const f = await fixture(dialect);
        try {
          await f.rows("UPDATE run_batches SET status='running' WHERE id=?", [batchId]);
          const job = await f.requests.create(input, "operator");
          await expect(
            f.service.execute(job.id, new AbortController().signal),
          ).rejects.toMatchObject({ code: "VERSION_COPY_SOURCE_ACTIVE" });
          expect((await f.repository.get(job.id))?.status).toBe("failed");
          expect((await f.structures.list("target")).versions).toEqual([]);
          await f.rows("UPDATE run_batches SET status='failed' WHERE id=?", [batchId]);
          await f.requests.action(job.id, "retry", "operator");
          const original = f.repository.insertPage.bind(f.repository);
          vi.spyOn(f.repository, "removeTarget").mockRejectedValueOnce(
            new Error("injected final cleanup DB failure"),
          );
          let requested = false;
          vi.spyOn(f.repository, "insertPage").mockImplementation(async (state, page, token) => {
            await original(state, page, token);
            if (!requested && page[0]?.collection === "run_batches") {
              requested = true;
              await f.requests.action(job.id, "cancel", "operator");
            }
          });
          await expect(
            f.service.execute(job.id, new AbortController().signal),
          ).rejects.toMatchObject({ code: "VERSION_COPY_CLEANUP_FAILED" });
          expect(await f.repository.get(job.id)).toMatchObject({
            status: "failed",
            phase: "cleanup",
            snapshot: null,
          });
          await f.requests.action(job.id, "retry", "operator");
          await f.service.execute(job.id, new AbortController().signal);
          const cancelled = await f.repository.get(job.id);
          expect(cancelled?.status).toBe("cancelled");
          expect(await f.rows("SELECT id FROM project_versions WHERE project_id='target'")).toEqual(
            [],
          );
          expect(await f.rows("SELECT id FROM case_sources WHERE project_id='target'")).toEqual([]);
          expect(await f.rows("SELECT id FROM run_batches WHERE project_id='target'")).toEqual([]);
          expect(
            (
              await f.objects.list({
                prefix: `projects/target/version-copies/${job.id}/`,
                limit: 100,
              })
            ).items,
          ).toEqual([]);
          expect(
            (
              await f.rows(
                "SELECT COUNT(*) AS count FROM ddt_cases WHERE project_version_id='version'",
              )
            )[0]?.count,
          ).toBe(dialect === "sqlite" ? 70 : "70");
        } finally {
          await f.close();
        }
      }, 60000);

      it("resumes committed pages after an interrupted worker and rejects corrupted objects instead of omitting them", async () => {
        const f = await fixture(dialect);
        try {
          const job = await f.requests.create(input, "operator");
          const original = f.repository.insertPage.bind(f.repository);
          let fault = true;
          vi.spyOn(f.repository, "insertPage").mockImplementation(async (state, page, token) => {
            await original(state, page, token);
            if (fault && page[0]?.collection === "ddt_cases") {
              fault = false;
              throw new Error("injected worker failure after commit");
            }
          });
          await expect(
            f.service.execute(job.id, new AbortController().signal),
          ).rejects.toMatchObject({ code: "VERSION_COPY_FAILED" });
          expect((await f.repository.get(job.id))?.status).toBe("failed");
          await f.requests.action(job.id, "retry", "operator");
          await f.service.execute(job.id, new AbortController().signal);
          expect((await f.repository.get(job.id))?.status).toBe("completed");
          const corrupted = await f.requests.create(
            { ...input, targetVersionName: "损坏校验", requestKey: "corrupt" },
            "operator",
          );
          await f.rows("UPDATE case_sources SET sha256=? WHERE id='jar'", ["f".repeat(64)]);
          await expect(
            f.service.execute(corrupted.id, new AbortController().signal),
          ).rejects.toMatchObject({ code: "VERSION_COPY_OBJECT_CORRUPT" });
          expect((await f.repository.get(corrupted.id))?.status).toBe("failed");
          expect(
            (await f.structures.list("target")).versions.map((version) => version.name),
          ).toEqual(["版本副本"]);
        } finally {
          await f.close();
        }
      }, 60000);
    },
  );

describe.skipIf(!postgresUrl)("version copy with independent PostgreSQL log payloads", () => {
  it("reads the source's original database and pins copied batches to the selected target database", async () => {
    const f = await fixture("postgres", { postgresLogs: true });
    try {
      await f.switchLogDatabase(1);
      const job = await f.requests.create(input, "operator");
      await f.service.execute(job.id, new AbortController().signal);
      const state = (await f.repository.get(job.id))!;
      expect(state.status).toBe("completed");
      const targetBatch = versionCopyId(state, batchId);
      const page = await f.logs.listChunks({
        batchId: targetBatch,
        attemptId: versionCopyId(state, attemptId),
        stream: "stdout",
        afterSequence: -1,
        limit: 100,
      });
      expect(page.items).toHaveLength(65);
      expect(page.items[0]?.content).toBe("首条中文日志");
      expect(
        await f.rows("SELECT database_id FROM run_batch_log_storage WHERE batch_id=?", [batchId]),
      ).toEqual([{ database_id: f.logDatabaseIds[0] }]);
      expect(
        await f.rows("SELECT database_id FROM run_batch_log_storage WHERE batch_id=?", [
          targetBatch,
        ]),
      ).toEqual([{ database_id: f.logDatabaseIds[1] }]);
    } finally {
      await f.close();
    }
  }, 60000);
});

async function fixture(dialect: "sqlite" | "postgres", options: { postgresLogs?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "version-copy-test-"));
  let admin: Client | undefined;
  let databaseName = "";
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: join(directory, "db.sqlite"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
        })
      : undefined;
  if (!sqlite) {
    admin = new Client({ connectionString: postgresUrl });
    await admin.connect();
    databaseName = `version_copy_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
  }
  const url = new URL(postgresUrl ?? "postgres://unused/unused");
  if (databaseName) url.pathname = `/${databaseName}`;
  const postgres = !sqlite
    ? createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
        poolMax: 2,
      })
    : undefined;
  await postgres?.ready;
  const rows = async (
    sql: string,
    values: readonly (string | number | boolean | null)[] = [],
  ): Promise<VersionCopyRow[]> => {
    if (sqlite) {
      const statement = sqlite.client.prepare(sql);
      const binds = values.map((value) => (typeof value === "boolean" ? Number(value) : value));
      if (statement.reader) return statement.all(...binds) as VersionCopyRow[];
      statement.run(...binds);
      return [];
    }
    let index = 0;
    return (
      await postgres!.pool.query(
        sql.replace(/\?/gu, () => `$${++index}`),
        [...values],
      )
    ).rows as VersionCopyRow[];
  };
  const insert = async (table: string, row: VersionCopyRow) => {
    const columns = Object.keys(row);
    await rows(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      Object.values(row),
    );
  };
  const repository = sqlite
    ? new SqliteProjectVersionCopyRepository(sqlite)
    : new PostgresProjectVersionCopyRepository(postgres!);
  const structures = sqlite
    ? new SqliteProjectStructureRepository(sqlite)
    : new PostgresProjectStructureRepository(postgres!);
  const publicAccess = sqlite
    ? new SqlitePublicExecutionAccessRepository(sqlite)
    : new PostgresPublicExecutionAccessRepository(postgres!);
  const objects = new LocalObjectStore(directory);
  await objects.ready();
  let logs: ReturnType<typeof createAttemptLogStore> | PostgresRoutedAttemptLogStore =
    createAttemptLogStore(join(directory, "attempt-logs"));
  const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 3).toString("base64"));
  const logDatabaseNames: string[] = [];
  const logDatabaseIds: string[] = [];
  let logRegistry: PostgresLogDatabaseRepository | undefined;
  const switchLogDatabase = async (index: number) => {
    if (!logRegistry) throw new Error("This fixture does not use PostgreSQL log payloads.");
    await logRegistry.select(logDatabaseIds[index]!, (await logRegistry.settings()).revision);
  };
  const close = async () => {
    await logs.close();
    await repository.close();
    sqlite?.close();
    await postgres?.close();
    if (admin) {
      for (const name of logDatabaseNames) await admin.query(`DROP DATABASE ${name}`);
      await admin.query(`DROP DATABASE ${databaseName}`);
      await admin.end();
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    if (postgres && options.postgresLogs) {
      logRegistry = new PostgresLogDatabaseRepository(
        postgres,
        cipher,
        "version-copy-platform",
        resolve("packages/db/drizzle/log-postgresql"),
      );
      logs = new PostgresRoutedAttemptLogStore(logRegistry, logs);
      for (let index = 0; index < 2; index++) {
        const name = `version_copy_logs_${randomUUID().replaceAll("-", "")}`;
        logDatabaseNames.push(name);
        await admin!.query(`CREATE DATABASE ${name}`);
        const logUrl = new URL(postgresUrl!);
        logUrl.pathname = `/${name}`;
        logDatabaseIds.push(
          (
            await logRegistry.register(
              randomUUID(),
              { name: `日志库 ${index}`, databaseUrl: logUrl.toString() },
              now,
            )
          ).id,
        );
      }
      await switchLogDatabase(0);
    }
    const common = { created_at: now, updated_at: now };
    const scope = { project_id: "source", project_version_id: "version", test_stage_id: "stage" };
    for (const id of ["source", "target"])
      await insert("projects", { id, name: id, slug: id, ...common });
    await insert("project_versions", {
      id: "version",
      project_id: "source",
      name: "原版本",
      normalized_name: "原版本",
      ...common,
    });
    await insert("test_stages", {
      id: "stage",
      project_id: "source",
      project_version_id: "version",
      name: "SIT",
      normalized_name: "sit",
      position: 0,
      ...common,
    });
    await insert("runners", {
      id: "runner",
      credential_hash: "hash",
      name: "runner",
      os: "linux",
      architecture: "amd64",
      agent_version: "1.20.9",
      protocol_version: 1,
      labels_json: "[]",
      max_concurrency: 1,
      busy_slots: 0,
      last_seen_at: now,
      ...common,
    });
    const objectsToSeed = [
      { objectKey: "projects/source/jars/source.jar", content: "offline-jar" },
      { objectKey: "projects/source/analysis/screenshot.png", content: "offline-screenshot" },
      {
        objectKey: "projects/source/ddt/input.csv",
        content: "CaseID,CaseName\n钱包-支付中文,中文名称",
      },
    ];
    for (const object of objectsToSeed)
      await objects.putObject({
        objectKey: object.objectKey,
        sha256: createHash("sha256").update(object.content).digest("hex"),
        sizeBytes: Buffer.byteLength(object.content),
        mediaType: "application/octet-stream",
        content: (async function* () {
          yield Buffer.from(object.content);
        })(),
      });
    const jar = objectsToSeed[0]!;
    const screenshot = objectsToSeed[1]!;
    const csv = objectsToSeed[2]!;
    const sha = (content: string) => createHash("sha256").update(content).digest("hex");
    await insert("case_sources", {
      id: "jar",
      ...scope,
      display_name: "jar",
      original_file_name: "source.jar",
      object_key: jar.objectKey,
      sha256: sha(jar.content),
      size_bytes: Buffer.byteLength(jar.content),
      class_count: 1,
      method_count: 1,
      status: "ready",
      warnings_json: "[]",
      inspection_json: "{}",
      ...common,
    });
    await insert("case_definitions", {
      id: "case",
      ...scope,
      source_id: "jar",
      class_name: "example.Test",
      package_name: "example",
      display_name: "原用例",
      enabled: true,
      groups_json: "[]",
      current_version: 1,
      parameters_json: JSON.stringify(data),
      ...common,
    });
    await insert("case_versions", {
      id: "case-version",
      case_definition_id: "case",
      source_id: "jar",
      version: 1,
      snapshot_json: JSON.stringify({
        id: "case",
        sourceId: "jar",
        projectId: "source",
        projectVersionId: "version",
        parameters: data,
      }),
      created_at: now,
    });
    await insert("test_methods", {
      id: "method",
      case_definition_id: "case",
      method_name: "test",
      descriptor: "()V",
      enabled: true,
      annotation_source: "method",
      groups_json: "[]",
      depends_on_methods_json: "[]",
      depends_on_groups_json: "[]",
      created_at: now,
    });
    await insert("ddt_import_jobs", {
      id: "import",
      ...scope,
      status: "succeeded",
      uploads_json: JSON.stringify([
        {
          id: "upload",
          objectKey: csv.objectKey,
          sha256: sha(csv.content),
          sizeBytes: Buffer.byteLength(csv.content),
        },
      ]),
      ...common,
    });
    await insert("ddt_import_files", {
      id: "file",
      job_id: "import",
      upload_id: "upload",
      file_name: "input.csv",
      status: "succeeded",
      ...common,
    });
    for (let index = 0; index < 70; index++)
      await insert("ddt_cases", {
        id: `ddt-${index}`,
        ...scope,
        case_id: `钱包-${index}`,
        case_id_normalized: `钱包-${index}`,
        sr_num: "SR",
        sr_num_normalized: "sr",
        case_kind: "standard",
        data_json: JSON.stringify(data),
        source_file_id: "file",
        execution_case_definition_id: "case",
        ...common,
      });
    await insert("ddt_case_history", {
      id: "ddt-history",
      ddt_case_id: "ddt-0",
      case_id: "钱包-0",
      change_type: "edit",
      before_json: JSON.stringify(data),
      after_json: JSON.stringify(data),
      changes_json: "[]",
      created_at: now,
    });
    const encrypted = cipher.encrypt("jenkins-secret", roundRecoverySecretPurpose("suite", "rule"));
    const policy = {
      projectVersionId: "version",
      runnerId: "runner",
      roundRecoveryRules: [{ id: "rule", jenkinsJobUrl: "http://internal/jenkins" }],
      roundRecoveryCredentials: { rule: encrypted },
    };
    await insert("case_suites", {
      id: "suite",
      project_id: "source",
      name: "混合任务",
      version: 1,
      policy_json: JSON.stringify(policy),
      ...common,
    });
    await insert("case_suite_items", {
      id: "member",
      suite_id: "suite",
      case_definition_id: "case",
      added_at: now,
    });
    await insert("case_suite_ddt_items", {
      id: "ddt-member",
      suite_id: "suite",
      ddt_case_id: "ddt-0",
      added_at: now,
    });
    await insert("case_suite_versions", {
      id: "suite-version",
      suite_id: "suite",
      version: 1,
      snapshot_json: JSON.stringify({ id: "suite", policy }),
      change_reason: "create",
      created_at: now,
    });
    await insert("case_suite_round_recovery_credentials", {
      suite_id: "suite",
      rule_id: "rule",
      api_key_ciphertext: encrypted,
      updated_at: now,
    });
    await insert("case_suite_schedules", {
      id: "schedule",
      suite_id: "suite",
      project_id: "source",
      cron_expression: "0 0 * * *",
      time_zone: "Asia/Shanghai",
      missed_run_policy: "skip",
      next_trigger_at: now,
      ...common,
    });
    await insert("run_batches", {
      id: batchId,
      project_id: "source",
      suite_id: "suite",
      suite_name: "混合任务",
      suite_version: 1,
      status: "failed",
      retry_limit: 0,
      total_runs: 1,
      environment_json: "[]",
      policy_json: JSON.stringify(policy),
      sequence_number: 10,
      ...common,
    });
    await insert("execution_runs", {
      id: "run",
      batch_id: batchId,
      case_definition_id: "ddt-0",
      execution_case_definition_id: "case",
      case_version: 1,
      display_name: "钱包-0",
      class_name: "example.Test",
      case_type: "ddt",
      class_data_json: JSON.stringify(data),
      status: "failed",
      attempt_count: 1,
      ...common,
    });
    await insert("run_batch_round_recoveries", {
      batch_id: batchId,
      rule_id: "rule",
      after_round: 1,
      next_round: 2,
      jenkins_job_url: "http://internal/jenkins",
      api_key_ciphertext: encrypted,
      wait_minutes: 1,
      status: "idle",
      available_at: now,
      ...common,
    });
    await insert("run_attempts", {
      id: attemptId,
      execution_run_id: "run",
      runner_id: "runner",
      attempt_number: 1,
      status: "failed",
      outcome: "failed",
      result_code: "TESTNG_ASSERTIONS_FAILED",
      scheduling_score: 1,
      created_at: now,
    });
    await insert("attempt_log_watermarks", {
      attempt_id: attemptId,
      stream: "stdout",
      acknowledged_sequence: 64,
      updated_at: now,
    });
    await logs.appendChunks({
      batchId,
      attemptId,
      receivedAt: now,
      chunks: Array.from({ length: 65 }, (_, sequence) => ({
        stream: "stdout" as const,
        sequence,
        content: sequence === 0 ? "首条中文日志" : `line-${sequence}`,
        recordedAt: now,
      })),
    });
    await insert("public_batch_access", {
      batch_id: batchId,
      created_by: "operator",
      created_at: now,
    });
    await insert("public_attempt_access", {
      attempt_id: attemptId,
      created_by: "operator",
      created_at: now,
    });
    await insert("failure_analysis_batches", {
      batch_id: batchId,
      project_id: "source",
      started_by: "operator",
      started_at: now,
    });
    await insert("failure_analysis_claims", {
      id: "analysis",
      project_id: "source",
      batch_id: batchId,
      execution_run_id: "run",
      case_definition_id: "ddt-0",
      attempt_id: attemptId,
      case_name: "钱包-0",
      class_name: "example.Test",
      attempt_number: 1,
      failure_summary: "assertion",
      status: "claimed",
      claimant_id: "operator",
      claimant_username: "operator",
      claimant_display_name: "操作人",
      claimed_at: now,
      updated_at: now,
      remark: "保留分析结论",
      screenshot_object_key: screenshot.objectKey,
      screenshot_sha256: sha(screenshot.content),
      screenshot_size_bytes: Buffer.byteLength(screenshot.content),
    });
    const authorize = vi.fn(async () => {});
    const clock = { now: () => new Date(now) };
    const ids = { next: randomUUID };
    const requests = new ProjectVersionCopyRequests({ repository, authorize, clock, ids });
    const service = new ProjectVersionCopyService({
      repository,
      archive: new VersionCopyArchive(repository, objects, directory),
      objects,
      logs,
      cipher,
      clock,
      ids,
      authorize,
      invalidate: async () => {},
    });
    return {
      directory,
      logDatabaseIds,
      switchLogDatabase,
      rows,
      repository,
      structures,
      publicAccess,
      objects,
      objectsToSeed,
      logs,
      cipher,
      requests,
      service,
      authorize,
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}
