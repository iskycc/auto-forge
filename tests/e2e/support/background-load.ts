import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { buildClassFile } from "../../../packages/testng-discovery/test/class-fixture";
import { browserJson } from "./session";

/** Persisted imports and exports share platform capacity with the execution workflow. */
export async function startBackgroundLoad(
  page: Page,
  scope: { versionId: string; stageId: string },
) {
  const suffix = randomUUID().replaceAll("-", "");
  const parameters = new URLSearchParams({
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: scope.versionId,
    testStageId: scope.stageId,
  });
  const headers = { origin: new URL(page.url()).origin };
  const pending: Array<{ url: string; expected: string }> = [];
  const previews: string[] = [];
  for (let file = 0; file < 2; file++) {
    const csv =
      "CaseID,srNum,value\n" +
      Array.from(
        { length: 4_000 },
        (_, row) => `BG-${suffix}-${file}-${row},BACKGROUND,${"payload".repeat(32)}\n`,
      ).join("");
    const preview = await page.request.post(`/api/v1/ddt/imports/preview?${parameters}`, {
      headers,
      multipart: {
        files: { name: `background-${file}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) },
      },
    });
    expect(preview.status(), await preview.text()).toBe(201);
    const job = (await preview.json()) as { id: string; validFiles: number };
    expect(job.validFiles).toBe(1);
    previews.push(job.id);
  }
  for (const id of previews) {
    const confirmed = await browserJson(page, `/api/v1/ddt/imports/${id}/confirm?${parameters}`, {
      method: "POST",
      body: { conflictStrategy: "overwrite" },
    });
    expect(confirmed.status).toBe(200);
    pending.push({ url: `/api/v1/ddt/imports/${id}?${parameters}`, expected: "succeeded" });
  }
  for (let file = 0; file < 3; file++) {
    const jar = zipSync(
      Object.fromEntries(
        Array.from({ length: 2_000 }, (_, row) => {
          const className = `background.p${suffix}.f${file}.Case${row}`;
          return [
            `${className.replaceAll(".", "/")}.class`,
            buildClassFile({
              className,
              methods: [{ name: "passes", annotations: [{ type: "Test", values: {} }] }],
            }),
          ];
        }),
      ),
    );
    const response = await page.request.post(`/api/v1/case-sources/jar/import?${parameters}`, {
      headers: { ...headers, "idempotency-key": `background-${suffix}-${file}` },
      multipart: {
        file: {
          name: `background-${suffix}-${file}.jar`,
          mimeType: "application/java-archive",
          buffer: Buffer.from(jar),
        },
      },
    });
    expect(response.status(), await response.text()).toBe(202);
    const job = (await response.json()) as { id: string };
    pending.push({ url: `/api/v1/case-sources/jar/imports/${job.id}`, expected: "succeeded" });
  }
  for (const format of ["csv", "json"]) {
    const response = await browserJson<{ id: string }>(page, "/api/v1/analytics/exports", {
      method: "POST",
      body: {
        filter: { projectId: DEFAULT_PROJECT_ID, projectVersionId: scope.versionId },
        format,
      },
    });
    expect(response.status).toBe(202);
    pending.push({ url: `/api/v1/analytics/exports/${response.body.id}`, expected: "succeeded" });
  }
  return async () => {
    for (const job of pending) {
      await expect
        .poll(
          async () => {
            const response = await page.request.get(job.url);
            expect(response.status()).toBe(200);
            const current = (await response.json()) as { status: string; errorSummary?: string };
            if (current.status === "failed")
              throw new Error(current.errorSummary ?? `Background job failed: ${job.url}`);
            return current.status;
          },
          { timeout: 180_000, intervals: [100, 250, 500] },
        )
        .toBe(job.expected);
      if (job.url.startsWith("/api/v1/analytics/exports/")) {
        const download = await page.request.get(`${job.url}/download`);
        expect(download.status()).toBe(200);
        expect((await download.body()).length).toBeGreaterThan(0);
      }
    }
  };
}
