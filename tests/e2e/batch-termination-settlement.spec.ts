import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { insertFailureAnalysisFixture } from "./support/failure-analysis-fixture";
import {
  browserJson,
  ensureAdministrator,
  selectProjectContext,
  uniqueName,
} from "./support/session";
import { expectUiIntegrity, expectReadableText } from "./support/ui-guard";

test("termination stays visibly active while leased work drains and settles without another Runner request", async ({
  page,
}, testInfo) => {
  await ensureAdministrator(page);
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${DEFAULT_PROJECT_ID}/versions`,
    { method: "POST", body: { name: uniqueName("终止恢复验收") } },
  );
  await selectProjectContext(page, DEFAULT_PROJECT_ID, version.body.id);
  const directory = process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("This Lite fixture requires AUTOFORGE_E2E_DATA_DIR.");
  const suffix = uniqueName("termination");
  const fixture = insertFailureAnalysisFixture(directory, version.body.id, suffix);
  const runId = `run-failed-0-${suffix}`;
  const attemptId = `attempt-${runId}`;
  const assignmentId = `assignment-${suffix}`;
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 600000).toISOString();
  const database = new DatabaseSync(resolve(directory, "db", "autoforge.sqlite"));
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database
      .prepare(
        "UPDATE run_batches SET status='running',retry_limit=9,retry_mode='round',scheduled_for=?,version=version+1 WHERE id=?",
      )
      .run(now, fixture.batchId);
    database
      .prepare(
        "UPDATE execution_runs SET status='failed',terminal_outcome='failed' WHERE batch_id=?",
      )
      .run(fixture.batchId);
    database
      .prepare(
        "UPDATE run_attempts SET status='failed',outcome='failed',result_code='TESTNG_ASSERTIONS_FAILED' WHERE execution_run_id IN (SELECT id FROM execution_runs WHERE batch_id=?)",
      )
      .run(fixture.batchId);
    database
      .prepare("UPDATE execution_runs SET status='running',terminal_outcome=NULL WHERE id=?")
      .run(runId);
    database
      .prepare(
        "UPDATE run_attempts SET status='running',outcome=NULL,started_at=?,finished_at=NULL WHERE id=?",
      )
      .run(now, attemptId);
    database
      .prepare(
        "INSERT INTO assignments(id,attempt_id,execution_run_id,batch_id,runner_id,status,priority,execution_spec_json,available_at,claim_deadline_at,claimed_at,created_at,updated_at) VALUES (?,?,?,?,?,'running',0,'{}',?,?,?,?,?)",
      )
      .run(
        assignmentId,
        attemptId,
        runId,
        fixture.batchId,
        `analysis-runner-${suffix}`,
        now,
        expiry,
        now,
        now,
        now,
      );
    database
      .prepare(
        "INSERT INTO assignment_leases(id,assignment_id,runner_id,token_hash,token_encrypted,status,version,expires_at,renewed_at,created_at) VALUES (?,?,?,?,'fixture-encrypted','active',1,?,?,?)",
      )
      .run(
        `lease-${suffix}`,
        assignmentId,
        `analysis-runner-${suffix}`,
        `fixture-hash-${suffix}`,
        expiry,
        now,
        now,
      );
    await page.goto(`/run-batches/${fixture.batchId}`);
    const actions = page.getByRole("region", { name: "批次操作", exact: true });
    await actions.getByRole("button", { name: "终止任务", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "终止执行任务", exact: true });
    await confirmation.getByRole("button", { name: "确认终止", exact: true }).click();
    const terminating = actions.getByRole("status");
    await expect(terminating).toHaveText("终止中");
    await expect(terminating.locator(".ant-tag")).toBeVisible();
    await expect(actions.getByRole("button", { name: "暂停任务", exact: true })).toHaveCount(0);
    const screenshots =
      process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? testInfo.outputPath("screenshots");
    await mkdir(screenshots, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page
        .context()
        .addCookies([
          { name: "autoforge-color-mode", value: theme, url: new URL("/", page.url()).href },
        ]);
      await page.reload();
      for (const width of [1024, 1536]) {
        await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
        await expect(terminating).toBeVisible();
        await expectReadableText(terminating.locator(".ant-tag"));
        await expectUiIntegrity(page);
        await page.screenshot({
          path: resolve(screenshots, `terminating-${theme}-${width}.png`),
          animations: "disabled",
        });
      }
    }
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        "UPDATE run_attempts SET status='failed',outcome='failed',result_code='TESTNG_ASSERTIONS_FAILED',finished_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), attemptId);
    database.prepare("UPDATE assignments SET status='completed' WHERE id=?").run(assignmentId);
    database
      .prepare("UPDATE assignment_leases SET status='released' WHERE assignment_id=?")
      .run(assignmentId);
    // A stale round retry models the completion/termination race; no Agent will claim it.
    database
      .prepare("UPDATE execution_runs SET status='queued',held_round=2 WHERE id=?")
      .run(runId);
    database.exec("COMMIT");
    await expect(actions.getByText("任务已终止", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(terminating).toHaveCount(0);
    const settled = await browserJson<{
      status: string;
      currentRound: number;
      attempts: { outcome: string }[];
    }>(page, `/api/v1/run-batches/${fixture.batchId}`);
    expect(settled.body.status).toBe("cancelled");
    expect(settled.body.currentRound).toBe(1);
    expect(settled.body.attempts).toHaveLength(5);
    expect(settled.body.attempts.every((attempt) => attempt.outcome === "failed")).toBe(true);
    await expect(page.getByRole("button", { name: "总体调度日志", exact: true })).toBeVisible({
      timeout: 20000,
    });
    for (const width of [1024, 1536]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
      await expectUiIntegrity(page);
      await page.screenshot({
        path: resolve(screenshots, `terminated-dark-${width}.png`),
        animations: "disabled",
      });
    }
  } finally {
    database.close();
  }
});
