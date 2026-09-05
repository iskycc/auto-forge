import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { IdentityAccessRepository } from "@autoforge/application";
import { builtInRoleDefinitions, DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} analysis assignees`,
    () => {
      it("only selects active users with both execution access and analysis rights in this project", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "analysis-assignees-"));
        const handle =
          dialect === "sqlite"
            ? createSqliteDatabase({
                databasePath: resolve(directory, "identity.sqlite"),
                migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
              })
            : createPostgresDatabase({
                connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
                migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
              });
        const repository: IdentityAccessRepository =
          "pool" in handle
            ? new PostgresIdentityAccessRepository(handle)
            : new SqliteIdentityAccessRepository(handle);
        const prefix = randomUUID();
        const recordedAt = "2026-09-05T00:00:00.000Z";
        const userIds: string[] = [];
        try {
          await repository.ensureBuiltInRoles(builtInRoleDefinitions, recordedAt);
          for (const roleKey of [
            "system-admin",
            "project-admin",
            "execution-operator",
            "viewer",
            "disabled",
            "unassigned",
          ]) {
            const id = randomUUID();
            userIds.push(id);
            const username = `${prefix}-${roleKey}`;
            await repository.createLocalUser({
              id,
              username,
              normalizedUsername: username,
              displayName: username,
              passwordHash: "test-only",
              forcePasswordChange: false,
              createdAt: recordedAt,
            });
            const role = builtInRoleDefinitions.find(
              (definition) =>
                definition.key === (roleKey === "disabled" ? "execution-operator" : roleKey),
            );
            if (role?.scope === "system")
              await repository.assignSystemRole(id, role.id, id, recordedAt);
            else if (role)
              await repository.assignProjectRole({
                userId: id,
                projectId: DEFAULT_PROJECT_ID,
                roleId: role.id,
                actorId: id,
                assignedAt: recordedAt,
              });
            if (roleKey === "disabled")
              await repository.updateUserStatus(id, "disabled", recordedAt);
          }
          const projectBindings = await repository.listUserProjectRoleBindings(
            userIds.slice(1, 3),
            [DEFAULT_PROJECT_ID],
          );
          expect(projectBindings.map((binding) => binding.userId).sort()).toEqual(
            userIds.slice(1, 3).sort(),
          );
          expect(await repository.listUserProjectRoleBindings(userIds, ["forbidden"])).toEqual([]);
          const memberPage = await repository.listProjectMemberships(DEFAULT_PROJECT_ID, {
            limit: 2,
            query: prefix,
          });
          expect(memberPage).toHaveLength(2);
          const nextMembers = await repository.listProjectMemberships(DEFAULT_PROJECT_ID, {
            limit: 2,
            query: prefix,
            afterUserId: memberPage.at(-1)!.user.id,
          });
          expect(
            new Set([...memberPage, ...nextMembers].map((member) => member.user.id)).size,
          ).toBe(4);
          expect(
            await repository.listProjectMemberships(DEFAULT_PROJECT_ID, {
              limit: 2,
              query: "missing%_",
            }),
          ).toEqual([]);
          expect(await repository.listSystemRoleBindings([userIds[0]!])).toEqual([
            expect.objectContaining({ userId: userIds[0] }),
          ]);
          const bindingPage = await repository.listSystemRoleBindings(undefined, { limit: 1 });
          expect(new Set(bindingPage.map((binding) => binding.userId)).size).toBeLessThanOrEqual(1);
          const first = await repository.listUsers({
            analysisProjectId: DEFAULT_PROJECT_ID,
            query: prefix,
            limit: 2,
          });
          expect(first.items).toHaveLength(2);
          expect(first.nextCursor).toBeTruthy();
          const second = await repository.listUsers({
            analysisProjectId: DEFAULT_PROJECT_ID,
            query: prefix,
            cursor: first.nextCursor!,
            limit: 2,
          });
          expect(
            [...first.items, ...second.items]
              .map((user) => user.username.replace(`${prefix}-`, ""))
              .sort(),
          ).toEqual(["execution-operator", "project-admin", "system-admin"]);
          expect(
            (
              await repository.listUsers({
                analysisProjectId: "another-project",
                query: prefix,
                limit: 10,
              })
            ).items.map((user) => user.id),
          ).toEqual([userIds[0]]);
          expect(
            (
              await repository.listUsers({
                analysisProjectId: DEFAULT_PROJECT_ID,
                userId: userIds[4]!,
                limit: 1,
              })
            ).items,
          ).toEqual([]);
        } finally {
          if ("pool" in handle) {
            await handle.pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [userIds]);
            await handle.close();
          } else handle.close();
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  );
}
