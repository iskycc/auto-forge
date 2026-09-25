import { expect, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { buildClassFile } from "../../../packages/testng-discovery/test/class-fixture";
import { browserJson, uniqueName } from "./session";

export async function createInitializationProject(page: Page) {
  const name = uniqueName("version-init");
  const project = await browserJson<{ id: string }>(page, "/api/v1/projects", {
    method: "POST",
    body: { name, slug: name },
  });
  expect(project.status).toBe(201);
  return { projectId: project.body.id, name };
}

export async function seedInitializationSource(page: Page, projectId: string) {
  const version = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${projectId}/versions`,
    { method: "POST", body: { name: "来源版本_完整支付回归_".repeat(4) } },
  );
  expect(version.status).toBe(201);
  const stage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${projectId}/versions/${version.body.id}/stages`,
    { method: "POST", body: { name: "SIT", description: "初始化来源阶段" } },
  );
  expect(stage.status).toBe(201);
  const scope = { projectId, projectVersionId: version.body.id, testStageId: stage.body.id };
  const query = new URLSearchParams(scope).toString();
  const headers = { origin: new URL(page.url()).origin };
  const className = "com.example.InitializationPaymentTest";
  const jar = zipSync({
    "com/example/InitializationPaymentTest.class": buildClassFile({
      className,
      methods: [{ name: "payment", annotations: [{ type: "Test", values: {} }] }],
    }),
  });
  const imported = await page.request.post(`/api/v1/case-sources/jar/import?${query}`, {
    headers: { ...headers, "Idempotency-Key": uniqueName("initialization-jar") },
    multipart: {
      file: {
        name: "initialization.jar",
        mimeType: "application/java-archive",
        buffer: Buffer.from(jar),
      },
    },
  });
  expect([200, 202]).toContain(imported.status());
  await expect
    .poll(
      async () =>
        (
          await browserJson<{ items: Array<{ id: string }> }>(
            page,
            `/api/v1/case-definitions?${query}`,
          )
        ).body.items.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  const classId = (
    await browserJson<{ items: Array<{ id: string }> }>(page, `/api/v1/case-definitions?${query}`)
  ).body.items[0]!.id;
  const preview = await page.request.post(`/api/v1/ddt/imports/preview?${query}`, {
    headers,
    multipart: {
      files: {
        name: "initialization.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("CaseID,srNum,CaseName,amount\nPAY-1,PAY,支付回归,12\n"),
      },
    },
  });
  expect(preview.status()).toBe(201);
  const job = (await preview.json()) as { id: string };
  expect(
    (
      await page.request.post(`/api/v1/ddt/imports/${job.id}/confirm?${query}`, {
        headers,
        data: { conflictStrategy: "skip" },
      })
    ).status(),
  ).toBe(200);
  await expect
    .poll(
      async () =>
        (await page.request.get(`/api/v1/ddt/imports/${job.id}?${query}`))
          .json()
          .then((body: { status: string }) => body.status),
      { timeout: 30_000 },
    )
    .toBe("succeeded");
  expect(
    (
      await browserJson(page, `/api/v1/ddt/execution-range?${query}`, {
        method: "POST",
        body: { caseDefinitionId: classId, className, included: true, expectedRevision: 0 },
      })
    ).status,
  ).toBe(200);
  const category = await browserJson<{ id: string }>(
    page,
    `/api/v1/ddt/requirement-categories?${query}`,
    { method: "POST", body: { name: "支付", className, expectedRevision: 0 } },
  );
  expect(category.status).toBe(200);
  expect(
    (
      await browserJson(page, `/api/v1/ddt/sr-categories?${query}`, {
        method: "POST",
        body: { srNum: "PAY", categoryId: category.body.id, expectedRevision: 0 },
      })
    ).status,
  ).toBe(200);
  const suiteName = "初始化混合任务_".repeat(8);
  const suite = await browserJson<{ id: string }>(page, "/api/v1/case-suites", {
    method: "POST",
    body: { projectId, projectVersionId: version.body.id, name: suiteName },
  });
  expect(suite.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suite.body.id}/cases`, {
        method: "POST",
        body: { caseDefinitionIds: [classId] },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await browserJson(page, `/api/v1/case-suites/${suite.body.id}/ddt-cases`, {
        method: "POST",
        body: { testStageId: stage.body.id, caseIds: ["PAY-1"] },
      })
    ).status,
  ).toBe(200);
  return { ...scope, classId, suiteId: suite.body.id, suiteName };
}

export async function openNewVersionWizard(page: Page, name: string) {
  await page.getByRole("button", { name: "当前项目版本", exact: true }).click();
  await page.getByRole("button", { name: "新建项目版本", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建项目版本", exact: true });
  await create.getByLabel("版本名称", { exact: true }).fill(name);
  await create.getByRole("button", { name: "新建项目版本", exact: true }).click();
  const wizard = page.getByRole("dialog", { name: "版本初始化", exact: true });
  await expect(wizard).toBeVisible();
  await expect(wizard.getByText("正在读取可继承配置…")).toHaveCount(0);
  return wizard;
}
