import { expect, test, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import type { ClaimAssignmentsResponse } from "@autoforge/contracts";
import { COTEST_ADAPTER_CAPABILITY, DDT_CASE_ID_CAPABILITY } from "@autoforge/domain";
import { buildClassFile } from "../../packages/testng-discovery/test/class-fixture";
import {
  ensureAdministrator,
  browserJson,
  selectProjectContext,
  acceptSystemDialog,
  E2E_ADMIN_USERNAME,
  E2E_ADMIN_PASSWORD,
} from "./support/session";
import {
  createInitializationProject,
  seedInitializationSource,
} from "./support/version-initialization";
import { freshRunnerBootstrapToken } from "./support/runner-bootstrap";
import { expectUiIntegrity } from "./support/ui-guard";

type ClaimedAssignment = ClaimAssignmentsResponse["assignments"][number];

const capabilities = [
  "executor:testng-v1",
  "isolation:cgroup-v2",
  "java:21.0.8",
  "testng:7.11.0",
  COTEST_ADAPTER_CAPABILITY,
  "adapter:ddt-insight-url-v1",
  DDT_CASE_ID_CAPABILITY,
];
const className = "com.example.InitializationPaymentTest";

test("debug workspace imports JAR and personal DDT assets, executes existing and uploaded cases and preserves inline results", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const project = await createInitializationProject(page);
  const source = await seedInitializationSource(page, project.projectId);
  await selectProjectContext(page, project.projectId, source.projectVersionId, source.testStageId);
  const scope = {
    projectId: source.projectId,
    projectVersionId: source.projectVersionId,
    testStageId: source.testStageId,
  };
  const query = new URLSearchParams(scope).toString();
  const headers = { origin: new URL(page.url()).origin };
  await seedAdditionalDebugCandidates(page, query, headers);
  const jar = Buffer.from(
    zipSync({
      "com/example/InitializationPaymentTest.class": buildClassFile({
        className,
        methods: [{ name: "debugNewMethod", annotations: [{ type: "Test", values: {} }] }],
      }),
    }),
  );
  const registration = await page.request.post("/api/v1/runner-agents/register", {
    headers: { authorization: `Bearer ${freshRunnerBootstrapToken()}` },
    data: {
      schemaVersion: 1,
      name: `调试执行机_${randomUUID()}`,
      labels: ["linux", "java", "testng"],
      capabilities,
      maxConcurrency: 1,
      os: "linux",
      architecture: "amd64",
      agentVersion: "0.7.2",
      protocolVersion: 1,
      terminalEnabled: false,
    },
  });
  expect(registration.status()).toBe(201);
  const runner = (await registration.json()) as { runnerId: string; credential: string };
  await heartbeat(page, runner);
  await page.goto("/case-debug");
  await expect(page.getByRole("heading", { name: "用例调试", exact: true })).toBeVisible();
  let panel = page.getByRole("region", { name: "普通用例调试配置" });
  const classInput = panel.getByLabel("测试类输入", { exact: true });
  await expect(classInput.locator("option")).toHaveCount(51);
  await expect(classInput.locator(`option[value="${source.classId}"]`)).toHaveCount(0);
  await classInput.getByLabel("搜索测试类", { exact: true }).fill("  PAYMENT  ");
  await classInput.getByRole("button", { name: "检索测试类", exact: true }).click();
  await expect(classInput.locator(`option[value="${source.classId}"]`)).toHaveCount(1);
  let directoryReads = 0;
  page.on("request", (request) => {
    if (/\/read-models\/[^/]+\/branches\?/.test(request.url())) directoryReads += 1;
  });
  await classInput.getByRole("button", { name: "从目录树选择", exact: true }).click();
  const casePicker = page.getByRole("dialog", { name: "选择调试用例", exact: true });
  await expect(casePicker.getByRole("tree")).toBeVisible();
  await expect(casePicker.getByText(className, { exact: true })).toHaveCount(0);
  await expect.poll(() => directoryReads).toBe(1);
  for (const segment of ["com", "example"]) {
    const directoryNode = casePicker.locator(".ant-tree-treenode").filter({
      has: page.locator(".ant-tree-title").filter({ hasText: new RegExp(`^${segment}\\d+$`) }),
    });
    await directoryNode.locator(".ant-tree-switcher").click();
  }
  await expect(casePicker.getByText(className, { exact: true })).toBeVisible();
  await expect.poll(() => directoryReads).toBe(3);
  await expect(casePicker.getByText("com.unopened.Extra0", { exact: true })).toHaveCount(0);
  await screenshotReview(page, "ordinary-case-tree");
  await casePicker.getByText(className, { exact: true }).click();
  await casePicker.getByRole("button", { name: "确认选择", exact: true }).click();
  await expect(casePicker).toHaveCount(0);
  await expect(classInput.locator('select[aria-label="调试测试类"]')).toHaveValue(source.classId);
  await classInput.getByRole("button", { name: "从目录树选择", exact: true }).click();
  await casePicker.getByLabel("搜索目录用例").fill("payment");
  await casePicker.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(casePicker.getByRole("tree")).toBeVisible();
  await casePicker.getByRole("button", { name: "取消", exact: true }).click();
  await expect(classInput.locator('select[aria-label="调试测试类"]')).toHaveValue(source.classId);
  await panel.locator('select[aria-label="调试执行机"]').selectOption(runner.runnerId);
  await expect(panel.getByLabel("调试启用 Adapter")).toBeChecked();
  await expect(panel.getByLabel("调试 Suite Name")).toHaveValue(project.name);
  await panel.getByLabel("调试启用 Adapter").scrollIntoViewIfNeeded();
  await screenshotReview(page, "ordinary-adapter-default-enabled");
  await panel.getByLabel("调试 Suite Name").fill("Remembered ordinary suite");
  await panel.getByLabel("调试 Test Name").fill("Remembered ordinary test");
  await panel.getByLabel("调试环境地址").fill("127.0.0.1");
  await panel.getByLabel("调试启用 Adapter").uncheck();
  await page.goto("/cases");
  await page.goto("/case-debug");
  await expect(classInput.locator('select[aria-label="调试测试类"]')).toHaveValue(source.classId);
  await expect(panel.locator('select[aria-label="调试执行机"]')).toHaveValue(runner.runnerId);
  await expect(panel.getByLabel("调试启用 Adapter")).not.toBeChecked();
  await panel.getByLabel("调试启用 Adapter").check();
  await expect(panel.getByLabel("调试 Suite Name")).toHaveValue("Remembered ordinary suite");
  await expect(panel.getByLabel("调试 Test Name")).toHaveValue("Remembered ordinary test");
  await expect(panel.getByLabel("调试环境地址")).toHaveValue("127.0.0.1");
  await panel.getByLabel("调试启用 Adapter").uncheck();
  await expect(panel.getByLabel("调试配置保存状态")).toHaveText("配置已自动保存到当前浏览器");
  await screenshotReview(page, "ordinary-existing");
  await heartbeat(page, runner);
  await panel.getByRole("button", { name: "开始调试", exact: true }).click();
  await expect(page).toHaveURL(/testngBatch=/);
  const existingClaim = await claim(page, runner);
  expect(existingClaim.assignment.executionSpec.className).toBe(className);
  await logAndComplete(page, runner, existingClaim);
  await expect(page.getByLabel("调试执行结果")).toContainText("执行通过");

  await classInput.getByRole("button", { name: "上传 JAR", exact: true }).click();
  const jarDialog = page.getByRole("dialog", { name: "上传并导入测试 JAR", exact: true });
  await expect(jarDialog.getByText("尚未配置", { exact: true })).toHaveCount(0);
  await jarDialog.locator('input[type="file"]').setInputFiles({
    name: `调试新版本_${"支付回归_".repeat(10)}.jar`,
    mimeType: "application/java-archive",
    buffer: jar,
  });
  await screenshotReview(page, "jar-import-selected");
  await jarDialog.getByRole("button", { name: "扫描测试类", exact: true }).click();
  await expect(jarDialog.getByRole("button", { name: "确认导入", exact: true })).toBeEnabled();
  await screenshotReview(page, "jar-import-scanned");
  await jarDialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(jarDialog).toHaveCount(0);
  await expect(classInput.locator('select[aria-label="调试测试类"]')).toHaveValue(source.classId);
  await heartbeat(page, runner);
  await panel.getByRole("button", { name: "再次执行", exact: true }).click();
  const newClaim = await claim(page, runner);
  const inputId = newClaim.assignment.executionSpec.inputs[0]!.inputId;
  const download = await page.request.get(
    `/api/v1/run-attempts/${newClaim.assignment.attemptId}/inputs/${inputId}`,
    { headers: { ...runnerHeaders(runner), "x-autoforge-lease-token": newClaim.lease.token } },
  );
  expect(download.status()).toBe(200);
  expect(
    createHash("sha256")
      .update(await download.body())
      .digest("hex"),
  ).toBe(createHash("sha256").update(jar).digest("hex"));
  await logAndComplete(page, runner, newClaim);
  await expect(page.getByLabel("调试日志内容")).toContainText("DEBUG_NEW_JAR_EXECUTED");
  await expect(page.getByLabel("调试执行结果")).toContainText("执行通过");
  const firstBatch = new URL(page.url()).searchParams.get("testngBatch");
  const logPanel = page.getByLabel("调试执行结果");
  await expect(page.getByLabel("调试日志内容")).toContainText("SECOND_DEBUG_LOG");
  await logPanel.getByRole("checkbox", { name: "跟随最新" }).uncheck();
  await expect(page.getByLabel("调试日志内容")).toContainText("DEBUG_NEW_JAR_EXECUTED");
  await logPanel.getByRole("button", { name: "回到开头", exact: true }).click();
  await expect(page.getByLabel("调试日志内容")).toContainText("DEBUG_NEW_JAR_EXECUTED");
  await expect(page.getByLabel("调试日志内容")).not.toContainText("SECOND_DEBUG_LOG");
  await logPanel.getByRole("button", { name: "下一段日志", exact: true }).click();
  await expect(page.getByLabel("调试日志内容")).toContainText("SECOND_DEBUG_LOG");
  await logPanel.getByRole("checkbox", { name: "跟随最新" }).check();
  await screenshotReview(page, "ordinary-result");
  await page.reload();
  await expect(classInput.locator('select[aria-label="调试测试类"]')).toHaveValue(source.classId);
  await expect(panel.locator('select[aria-label="调试执行机"]')).toHaveValue(runner.runnerId);
  await expect(page.getByLabel("调试日志内容")).toContainText("DEBUG_NEW_JAR_EXECUTED");
  expect(new URL(page.url()).searchParams.get("testngBatch")).toBe(firstBatch);
  const formalClasses = await browserJson<{ items: Array<{ id: string; currentVersion: number }> }>(
    page,
    `/api/v1/case-definitions?${query}&query=${encodeURIComponent(className)}`,
  );
  expect(formalClasses.body.items).toHaveLength(1);
  expect(formalClasses.body.items[0]).toMatchObject({ id: source.classId, currentVersion: 2 });

  const asset = await page.request.post(
    `/api/v1/projects/${scope.projectId}/runtime-assets/upload?kind=jar-bundle&archiveFormat=zip`,
    {
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-autoforge-file-name": encodeURIComponent("debug-runtime.zip"),
      },
      data: Buffer.from(zipSync({ "tests.jar": jar })),
    },
  );
  expect(asset.status(), await asset.text()).toBe(201);
  const assetId = ((await asset.json()) as { id: string }).id;
  expect(
    (
      await browserJson(
        page,
        `/api/v1/projects/${scope.projectId}/versions/${scope.projectVersionId}/adapter-configuration`,
        { method: "PUT", body: { jarBundleAssetId: assetId, expectedRevision: 0 } },
      )
    ).status,
  ).toBe(200);
  await panel.getByLabel("调试启用 Adapter").check();
  await panel.getByLabel("调试环境地址").fill("127.0.0.1");
  await heartbeat(page, runner);
  await panel.getByRole("button", { name: "再次执行", exact: true }).click();
  const ordinaryAdapter = await claim(page, runner);
  expect(ordinaryAdapter.assignment.executionSpec.adapter).toBeDefined();
  expect(ordinaryAdapter.assignment.executionSpec.adapter).not.toHaveProperty("ddtScope");
  expect(ordinaryAdapter.assignment.executionSpec.adapter).not.toHaveProperty("caseId");
  expect(ordinaryAdapter.assignment.executionSpec.requiredCapabilities).not.toContain(
    "adapter:ddt-insight-url-v1",
  );
  await logAndComplete(page, runner, ordinaryAdapter);
  await expect(page.getByLabel("调试执行结果")).toContainText("执行通过");
  await panel.getByRole("button", { name: "再次执行", exact: true }).click();
  const ordinaryFailure = await claim(page, runner);
  await logAndComplete(page, runner, ordinaryFailure, "failed");
  await expectCompletedDebugFailure(page, ordinaryFailure.assignment.executionSpec.batchId);
  await screenshotReview(page, "ordinary-assertion-failed");
  await panel.getByRole("button", { name: "再次执行", exact: true }).click();
  await logAndComplete(page, runner, await claim(page, runner));
  await expect(page.getByLabel("调试用例结果")).toHaveText("执行通过");
  await page.getByRole("tab", { name: "DDT 调试", exact: true }).click();
  panel = page.getByRole("region", { name: "DDT调试配置" });
  await expect(panel.getByLabel("调试启用 Adapter")).toBeChecked();
  await expect(panel.getByLabel("调试启用 Adapter")).toBeDisabled();
  const ddtInput = panel.getByLabel("DDT 用例输入", { exact: true });
  await ddtInput.getByRole("radio", { name: "复制现有用例", exact: true }).locator("..").click();
  await expect(ddtInput.locator("option")).toHaveCount(51);
  await expect(ddtInput.locator('option[value="PAY-1"]')).toHaveCount(0);
  await ddtInput.getByLabel("搜索DDT 用例", { exact: true }).fill("  aY-  ");
  await ddtInput.getByRole("button", { name: "检索DDT 用例", exact: true }).click();
  await expect(ddtInput.locator('option[value="PAY-1"]')).toHaveCount(1);
  await ddtInput.locator('select[aria-label="调试DDT 用例"]').selectOption("PAY-1");
  await expect(ddtInput.getByRole("radio", { name: "个人数据", exact: true })).toBeChecked();
  await ddtInput.getByLabel("搜索DDT 用例", { exact: true }).fill(" y-1 ");
  const personalSearch = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/case-debug/ddt/cases" && url.searchParams.get("query") === "y-1"
    );
  });
  await ddtInput.getByRole("button", { name: "检索DDT 用例", exact: true }).click();
  const personalMatches = await personalSearch;
  expect(personalMatches.status()).toBe(200);
  expect((await personalMatches.json()).items).toEqual([
    expect.objectContaining({ caseId: "PAY-1" }),
  ]);
  await expect(ddtInput.locator('option[value="PAY-1"]')).toHaveCount(1);
  await expect(panel.locator('select[aria-label="调试测试类"]')).toHaveValue(source.classId);
  await panel.locator('select[aria-label="调试执行机"]').selectOption(runner.runnerId);
  await panel.getByLabel("调试环境地址").fill("127.0.0.1");
  await panel.getByLabel("调试 Suite Name").fill("Remembered DDT suite");
  await panel.getByLabel("调试 Test Name").fill("Remembered DDT test");
  await page.reload();
  await expect(ddtInput.locator('select[aria-label="调试DDT 用例"]')).toHaveValue("PAY-1");
  await expect(panel.locator('select[aria-label="调试测试类"]')).toHaveValue(source.classId);
  await expect(panel.locator('select[aria-label="调试执行机"]')).toHaveValue(runner.runnerId);
  await expect(panel.getByLabel("调试 Suite Name")).toHaveValue("Remembered DDT suite");
  await expect(panel.getByLabel("调试 Test Name")).toHaveValue("Remembered DDT test");
  await expect(panel.getByLabel("调试环境地址")).toHaveValue("127.0.0.1");
  await screenshotReview(page, "ddt-existing");
  const personalAccess = await browserJson<{ ownerUserId: string; accessKey: string }>(
    page,
    `/api/v1/case-debug/ddt/workspace?${query}`,
  );
  const personalApi = `/api/v1/public/ddt/projects/${scope.projectId}/versions/${scope.projectVersionId}/stages/${scope.testStageId}/users/${personalAccess.body.ownerUserId}/debug/${personalAccess.body.accessKey}/case`;
  await expect(page.getByLabel("个人 DDT API", { exact: true })).toContainText(personalApi);
  await ddtInput.getByRole("button", { name: "查看 / 编辑个人数据", exact: true }).click();
  const personalEditor = page.getByRole("dialog", { name: "编辑个人调试数据", exact: true });
  const original = JSON.parse(
    await personalEditor.getByRole("textbox", { name: "个人 DDT JSON 数据" }).inputValue(),
  ) as Record<string, unknown>;
  await personalEditor
    .getByRole("textbox", { name: "个人 DDT JSON 数据" })
    .fill(JSON.stringify({ ...original, account: "only-my-debug-account" }, null, 2));
  await screenshotReview(page, "ddt-personal-editor");
  await personalEditor.getByRole("button", { name: "保存个人数据", exact: true }).click();
  await expect(personalEditor).toHaveCount(0);
  expect((await (await page.request.get(`${personalApi}?caseId=PAY-1`)).json()).account).toBe(
    "only-my-debug-account",
  );
  await heartbeat(page, runner);
  await panel.getByRole("button", { name: "开始调试", exact: true }).click();
  const existingDdt = await claim(page, runner);
  expect(existingDdt.assignment.executionSpec.adapter?.caseId).toBe("PAY-1");
  await logAndComplete(page, runner, existingDdt);
  await expect(page.getByLabel("调试执行结果").filter({ visible: true })).toContainText("执行通过");
  const normalApi = `/api/v1/public/ddt/projects/${scope.projectId}/versions/${scope.projectVersionId}/stages/${scope.testStageId}/case?caseId=PAY-1`;
  const immediate = await browserJson<{ id: string }>(
    page,
    `/api/v1/ddt/cases/PAY-1/execute?${query}`,
    {
      method: "POST",
      body: {
        runnerIds: [runner.runnerId],
        adapter: {
          enabled: true,
          suiteName: "Immediate",
          testName: "DDT",
          environmentAddresses: ["127.0.0.1"],
        },
      },
    },
  );
  expect(immediate.status, JSON.stringify(immediate.body)).toBe(201);
  const immediateDdt = await claim(page, runner);
  expect(immediateDdt.assignment.executionSpec.batchId).toBe(immediate.body.id);
  expect(immediateDdt.assignment.executionSpec.adapter).toMatchObject({
    caseId: "PAY-1",
    ddtScope: scope,
  });
  await logAndComplete(page, runner, immediateDdt);
  for (const [strategy, expectedAmount] of [
    ["跳过已有用例", "12"],
    ["覆盖个人数据", "99"],
  ] as const) {
    await ddtInput.getByRole("button", { name: "导入表格", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "导入 DDT 用例", exact: true });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: `调试数据-${strategy}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from("CaseID,srNum,CaseName,amount\nPAY-1,PAY,支付调试,99\n"),
    });
    await dialog.getByRole("button", { name: "开始预检", exact: true }).click();
    await expect(dialog.getByRole("button", { name: /确认并后台导入$/ })).toBeEnabled();
    await dialog.getByRole("radio", { name: strategy, exact: true }).check();
    await screenshotReview(
      page,
      strategy === "跳过已有用例" ? "ddt-import-skip" : "ddt-import-overwrite",
    );
    await dialog.getByRole("button", { name: /确认并后台导入$/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("调试表格导入进度")).toContainText("导入完成");
    const formalDdt = (await (await page.request.get(normalApi)).json()) as {
      amount: number | string;
    };
    expect(String(formalDdt.amount)).toBe("12");
    const personal = await (await page.request.get(`${personalApi}?caseId=PAY-1`)).json();
    expect(String(personal.amount)).toBe(expectedAmount);
  }
  const username = `debug-peer-${randomUUID().slice(0, 8)}`;
  const password = "DebugPeer!Password123";
  const created = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: "另一位调试用户", password, forcePasswordChange: false },
  });
  expect(created.status).toBe(201);
  const role = await browserJson<{ id: string }>(page, "/api/v1/roles", {
    method: "POST",
    body: {
      key: username,
      name: username,
      scope: "project",
      permissions: ["case.read", "run.create", "run.read"],
    },
  });
  expect(role.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/users/${created.body.id}/project-roles`, {
        method: "POST",
        body: { projectId: scope.projectId, roleId: role.body.id },
      })
    ).status,
  ).toBe(204);
  const peer = await page
    .context()
    .browser()!
    .newContext({ baseURL: new URL(page.url()).origin });
  try {
    expect(
      (
        await peer.request.post("/api/v1/auth/login", { headers, data: { username, password } })
      ).status(),
    ).toBe(200);
    const peerApi = `/api/v1/case-debug/ddt`;
    expect((await peer.request.get(`${peerApi}/cases/PAY-1?${query}`)).status()).toBe(404);
    expect(
      (
        await peer.request.post(`${peerApi}/copy?${query}`, { headers, data: { caseId: "PAY-1" } })
      ).status(),
    ).toBe(200);
    const peerCase = await (await peer.request.get(`${peerApi}/cases/PAY-1?${query}`)).json();
    expect(String(peerCase.data.amount)).toBe("12");
    const peerAccess = await (await peer.request.get(`${peerApi}/workspace?${query}`)).json();
    expect(peerAccess.accessKey).not.toBe(personalAccess.body.accessKey);
    const tamperedApi = personalApi.replace(
      personalAccess.body.ownerUserId,
      peerAccess.ownerUserId,
    );
    expect((await peer.request.get(`${tamperedApi}?caseId=PAY-1`)).status()).toBe(404);
    const jobPreview = await page.request.post(`/api/v1/case-debug/ddt/imports/preview?${query}`, {
      headers,
      multipart: {
        files: {
          name: "private.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("CaseID,srNum,account\nPRIVATE-ONLY,SR,secret-test-account\n"),
        },
      },
    });
    expect(jobPreview.status()).toBe(200);
    const privateJob = await jobPreview.json();
    expect((await peer.request.get(`${peerApi}/imports/${privateJob.id}?${query}`)).status()).toBe(
      404,
    );
    expect(
      (
        await peer.request.post(`${peerApi}/imports/${privateJob.id}/confirm?${query}`, {
          headers,
          data: { conflictStrategy: "overwrite" },
        })
      ).status(),
    ).toBe(404);
    expect((await page.request.get(`/api/v1/ddt/imports/${privateJob.id}?${query}`)).status()).toBe(
      404,
    );
  } finally {
    await peer.close();
  }
  await heartbeat(page, runner);
  await panel.getByRole("button", { name: "再次执行", exact: true }).click();
  const uploadedDdt = await claim(page, runner);
  expect(uploadedDdt.assignment.executionSpec.adapter?.caseId).toBe("PAY-1");
  expect(uploadedDdt.assignment.executionSpec.adapter?.ddtScope).toEqual({
    ...scope,
    debug: personalAccess.body,
  });
  expect(uploadedDdt.assignment.executionSpec.inputs.map((input) => input.kind)).toContain(
    "jar-bundle",
  );
  expect(uploadedDdt.assignment.executionSpec.adapter).not.toHaveProperty("classDataFile");
  await logAndComplete(page, runner, uploadedDdt, "skipped");
  await expectCompletedDebugFailure(page, uploadedDdt.assignment.executionSpec.batchId);
  await verifyDebugPaneScrolling(page);
  await screenshotReview(page, "ddt-failed-result");
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await screenshotReview(page, "ddt-dark-result");
  await page.getByRole("button", { name: "切换到浅色模式", exact: true }).click();
  const badScope = await browserJson(page, `/api/v1/case-debug/runs?${query}`, {
    method: "POST",
    body: {
      ...scope,
      testStageId: "other-stage",
      kind: "testng",
      caseDefinitionId: source.classId,
      execution: { runnerIds: [runner.runnerId] },
    },
  });
  expect(badScope.status).toBe(409);
  const missingCase = await browserJson(page, `/api/v1/case-debug/runs?${query}`, {
    method: "POST",
    body: {
      ...scope,
      kind: "testng",
      caseDefinitionId: "missing",
      execution: { runnerIds: [runner.runnerId] },
    },
  });
  expect(missingCase.status).toBe(404);
  const group = await browserJson<{ id: string }>(page, "/api/v1/runner-groups", {
    method: "POST",
    body: { name: `debug-group-${randomUUID()}`, runnerIds: [runner.runnerId] },
  });
  expect(group.status).toBe(201);
  await panel.getByRole("button", { name: "刷新资源", exact: true }).click();
  await panel.getByRole("radio", { name: "执行机组", exact: true }).locator("..").click();
  await expect(panel.locator(`option[value="${group.body.id}"]`)).toHaveCount(1);
  await panel.locator('select[aria-label="调试执行机组"]').selectOption(group.body.id);
  await page.reload();
  await expect(panel.getByRole("radio", { name: "执行机组", exact: true })).toBeChecked();
  await expect(panel.locator('select[aria-label="调试执行机组"]')).toHaveValue(group.body.id);
  await panel.getByRole("button", { name: "再次执行", exact: true }).click();
  await page
    .getByRole("button", { name: "停止执行", exact: true })
    .filter({ visible: true })
    .click();
  await acceptSystemDialog(page, "停止本次调试", "停止执行");
  await expect(page.getByLabel("调试执行结果").filter({ visible: true })).toContainText("已终止");
  await page.getByRole("tab", { name: "普通用例调试", exact: true }).click();
  const ordinaryPanel = page.getByRole("region", { name: "普通用例调试配置" });
  await expect(ordinaryPanel.getByLabel("调试 Suite Name")).toHaveValue(
    "Remembered ordinary suite",
  );
  await expect(ordinaryPanel.locator('select[aria-label="调试执行机"]')).toHaveValue(
    runner.runnerId,
  );
  await expect(page.getByLabel("调试执行结果").filter({ visible: true })).toContainText("执行通过");
  const anonymous = await page.context().browser()!.newContext();
  try {
    const unauthorized = await anonymous.request.post(
      `${new URL(page.url()).origin}/api/v1/case-debug/runs?${query}`,
      {
        headers,
        data: {
          ...scope,
          kind: "testng",
          caseDefinitionId: source.classId,
          execution: { runnerIds: [runner.runnerId] },
        },
      },
    );
    expect(unauthorized.status()).toBe(401);
  } finally {
    await anonymous.close();
  }
  const savedUrl = page.url();
  const anotherStage = await browserJson<{ id: string }>(
    page,
    `/api/v1/projects/${scope.projectId}/versions/${scope.projectVersionId}/stages`,
    { method: "POST", body: { name: "另一个调试阶段", description: "范围隔离验证" } },
  );
  expect(anotherStage.status).toBe(201);
  await selectProjectContext(page, scope.projectId, scope.projectVersionId, anotherStage.body.id);
  await page.goto(savedUrl);
  await expect(page.getByLabel("调试执行结果")).toHaveCount(0);
  await expect(ordinaryPanel.locator('select[aria-label="调试测试类"]')).toHaveValue("");
  await expect(ordinaryPanel.locator('select[aria-label="调试执行机"]')).toHaveValue("");
  await expect(ordinaryPanel.getByLabel("调试启用 Adapter")).toBeChecked();
  await ordinaryPanel.getByLabel("调试 Suite Name").fill("Other stage draft");
  await selectProjectContext(page, scope.projectId, scope.projectVersionId, scope.testStageId);
  await page.goto(savedUrl);
  await expect(ordinaryPanel.getByLabel("调试 Suite Name")).toHaveValue(
    "Remembered ordinary suite",
  );
  await expect(ordinaryPanel.locator('select[aria-label="调试测试类"]')).toHaveValue(
    source.classId,
  );
  await expect(page.getByLabel("调试执行结果").filter({ visible: true })).toContainText("执行通过");
});

test("debug drafts isolate accounts in the same browser and remain usable when storage fails", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const project = await createInitializationProject(page);
  const source = await seedInitializationSource(page, project.projectId);
  await selectProjectContext(page, project.projectId, source.projectVersionId, source.testStageId);
  await page.goto("/case-debug");
  const panel = page.getByRole("region", { name: "普通用例调试配置" });
  await panel.getByLabel("调试启用 Adapter").check();
  await panel.getByLabel("调试 Suite Name").fill("Administrator draft");
  const draftKey = await page.evaluate(() =>
    Object.keys(localStorage).find((key) => key.startsWith("autoforge.case-debug-draft.v1:"))!,
  );
  const username = `draft-peer-${randomUUID().slice(0, 8)}`;
  const password = "DraftPeer!Password123";
  const user = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: "配置隔离用户", password, forcePasswordChange: false },
  });
  expect(user.status).toBe(201);
  const role = await browserJson<{ id: string }>(page, "/api/v1/roles", {
    method: "POST",
    body: {
      key: username,
      name: username,
      scope: "project",
      permissions: ["case.read", "run.create", "run.read", "runner.read"],
    },
  });
  expect(role.status).toBe(201);
  expect(
    (
      await browserJson(page, `/api/v1/users/${user.body.id}/project-roles`, {
        method: "POST",
        body: { projectId: project.projectId, roleId: role.body.id },
      })
    ).status,
  ).toBe(204);
  const headers = { origin: new URL(page.url()).origin };
  expect((await page.request.post("/api/v1/auth/logout", { headers })).ok()).toBe(true);
  expect(
    (
      await page.request.post("/api/v1/auth/login", { headers, data: { username, password } })
    ).status(),
  ).toBe(200);
  await selectProjectContext(page, project.projectId, source.projectVersionId, source.testStageId);
  await page.goto("/case-debug");
  await expect(panel.getByLabel("调试启用 Adapter")).toBeChecked();
  await expect(panel.getByLabel("调试 Suite Name")).toHaveValue(project.name);
  await panel.getByLabel("调试 Suite Name").fill("Peer draft");
  expect((await page.request.post("/api/v1/auth/logout", { headers })).ok()).toBe(true);
  expect(
    (
      await page.request.post("/api/v1/auth/login", {
        headers,
        data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
      })
    ).status(),
  ).toBe(200);
  await selectProjectContext(page, project.projectId, source.projectVersionId, source.testStageId);
  await page.goto("/case-debug");
  await expect(panel.getByLabel("调试 Suite Name")).toHaveValue("Administrator draft");
  await page.evaluate((key) => localStorage.setItem(key, "{broken"), draftKey);
  await page.reload();
  await expect(panel.getByLabel("调试配置保存状态")).toContainText("已保存配置无法读取");
  await panel.getByLabel("调试启用 Adapter").check();
  await panel.getByLabel("调试 Suite Name").fill("Recovered draft");
  await page.reload();
  await expect(panel.getByLabel("调试 Suite Name")).toHaveValue("Recovered draft");
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("autoforge.case-debug-draft.v1:"))
        throw new DOMException("Storage full", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  await page.reload();
  await panel.getByLabel("调试 Suite Name").fill("Unsaved but usable");
  await expect(panel.getByLabel("调试 Suite Name")).toHaveValue("Unsaved but usable");
  await expect(panel.getByLabel("调试配置保存状态")).toContainText("浏览器无法保存配置");
  await screenshotReview(page, "draft-storage-warning");
});

async function heartbeat(page: Page, runner: { runnerId: string; credential: string }) {
  const response = await page.request.post(`/api/v1/runner-agents/${runner.runnerId}/heartbeat`, {
    headers: runnerHeaders(runner),
    data: {
      schemaVersion: 1,
      busySlots: 0,
      labels: ["linux", "java", "testng"],
      capabilities,
      maxConcurrency: 1,
      agentVersion: "0.7.2",
      terminalEnabled: false,
      resourceSnapshot: {
        cpuUtilizationPercent: 1,
        memoryUtilizationPercent: 1,
        loadAverage1m: 0.1,
        logicalCpuCount: 4,
        observedAt: new Date().toISOString(),
      },
    },
  });
  expect(response.status()).toBe(200);
}
function runnerHeaders(runner: { runnerId: string; credential: string }) {
  return { authorization: `Bearer ${runner.credential}`, "x-autoforge-runner-id": runner.runnerId };
}
async function claim(
  page: Page,
  runner: { runnerId: string; credential: string },
): Promise<ClaimedAssignment> {
  let assignment: ClaimedAssignment | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.post(
          `/api/v1/runner-agents/${runner.runnerId}/claims`,
          {
            headers: runnerHeaders(runner),
            data: {
              schemaVersion: 1,
              requestId: randomUUID(),
              availableSlots: 1,
              labels: ["linux", "java", "testng"],
              capabilities,
              waitSeconds: 0,
            },
          },
        );
        expect(response.status()).toBe(200);
        assignment = ((await response.json()) as { assignments: ClaimedAssignment[] })
          .assignments[0];
        return Boolean(assignment);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return assignment!;
}
async function logAndComplete(
  page: Page,
  runner: { runnerId: string; credential: string },
  claim: ClaimedAssignment,
  outcome: "succeeded" | "failed" | "skipped" = "succeeded",
) {
  const status = outcome === "succeeded" ? "succeeded" : "failed";
  const path = `/api/v1/run-attempts/${claim.assignment.attemptId}`;
  const logged = await page.request.post(`${path}/logs`, {
    headers: runnerHeaders(runner),
    data: {
      schemaVersion: 1,
      requestId: randomUUID(),
      leaseToken: claim.lease.token,
      chunks: [
        {
          stream: "stdout",
          sequence: 1,
          content: "SECOND_DEBUG_LOG\n",
          recordedAt: new Date().toISOString(),
        },
        {
          stream: "stdout",
          sequence: 0,
          content:
            `INFO DEBUG_NEW_JAR_EXECUTED\n执行结果：${status === "succeeded" ? "通过" : "失败"}\n` +
            (status === "failed"
              ? Array.from(
                  { length: 120 },
                  (_, index) => `ERROR 调试堆栈第 ${index + 1} 行\n`,
                ).join("")
              : ""),
          recordedAt: new Date().toISOString(),
        },
      ],
    },
  });
  expect(logged.status()).toBe(200);
  const completed = await page.request.post(`${path}/complete`, {
    headers: runnerHeaders(runner),
    data: {
      schemaVersion: 1,
      completionId: randomUUID(),
      leaseToken: claim.lease.token,
      result: {
        status,
        resultCode:
          outcome === "succeeded"
            ? "TESTNG_SUCCEEDED"
            : outcome === "skipped"
              ? "TESTNG_SKIPPED"
              : "TESTNG_ASSERTIONS_FAILED",
        summary:
          status === "succeeded"
            ? "调试用例执行完成"
            : "调试断言失败：" + "失败原因与调用堆栈".repeat(32),
        testNg: {
          total: 1,
          passed: status === "succeeded" ? 1 : 0,
          failed: outcome === "failed" ? 1 : 0,
          skipped: outcome === "skipped" ? 1 : 0,
          configurationFailures: 0,
          detailsTruncated: false,
          suites: [],
        },
        durationMs: 100,
        logWatermarks: { stdout: 1, stderr: -1, agent: -1 },
        artifacts: [],
      },
    },
  });
  expect(completed.status()).toBe(200);
}
async function expectCompletedDebugFailure(page: Page, batchId: string) {
  const completed = await browserJson<{
    status: string;
    failedRuns: number;
    succeededRuns: number;
  }>(page, `/api/v1/run-batches/${batchId}`);
  expect(completed.body).toMatchObject({ status: "succeeded", failedRuns: 1, succeededRuns: 0 });
  const results = page.getByRole("region", { name: "调试执行结果", exact: true });
  await expect(results).not.toContainText("执行通过");
  await expect(results.getByLabel("调试执行状态")).toHaveText("执行完成");
  await expect(results.getByLabel("调试用例结果")).toHaveText("执行失败");
  await expect(results.getByLabel("调试用例结果")).toHaveClass(/ant-tag-error/);
}

async function verifyDebugPaneScrolling(page: Page) {
  const configuration = page.getByRole("region", { name: "DDT调试配置", exact: true });
  const fields = configuration.getByRole("region", { name: "调试配置内容", exact: true });
  const results = page.getByRole("region", { name: "调试执行结果", exact: true });
  const logs = results.getByLabel("调试日志内容");
  await results.getByRole("checkbox", { name: "跟随最新" }).uncheck();
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => logs.evaluate((element) => element.clientHeight)).toBeGreaterThan(180);
    await fields.evaluate((element) => (element.scrollTop = 0));
    await logs.evaluate((element) => (element.scrollTop = 0));
    await fields.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => fields.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await logs.evaluate((element) => element.scrollTop)).toBe(0);
    const configurationScroll = await fields.evaluate((element) => element.scrollTop);
    await logs.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => logs.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await fields.evaluate((element) => element.scrollTop)).toBe(configurationScroll);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(
      configuration.getByRole("button", { name: "再次执行", exact: true }),
    ).toBeInViewport();

    const widthHandle = page.getByRole("separator", { name: "调整调试配置与日志宽度" });
    const oldWidth = await configuration.evaluate((element) => element.clientWidth);
    const widthBounds = (await widthHandle.boundingBox())!;
    await page.mouse.move(
      widthBounds.x + widthBounds.width / 2,
      widthBounds.y + widthBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(widthBounds.x + 50, widthBounds.y + widthBounds.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(() => configuration.evaluate((element) => element.clientWidth))
      .toBeGreaterThan(oldWidth + 20);
    await widthHandle.focus();
    await widthHandle.press("Home");
    await expect
      .poll(() => configuration.evaluate((element) => element.clientWidth))
      .toBe(oldWidth);

    const heightHandle = results.getByRole("separator", { name: "调整执行信息与日志高度" });
    const oldHeight = await logs.evaluate((element) => element.clientHeight);
    const heightBounds = (await heightHandle.boundingBox())!;
    await page.mouse.move(
      heightBounds.x + heightBounds.width / 2,
      heightBounds.y + heightBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(heightBounds.x + heightBounds.width / 2, heightBounds.y - 48, {
      steps: 5,
    });
    await page.mouse.up();
    await expect
      .poll(() => logs.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(oldHeight + 20);
    await heightHandle.focus();
    await heightHandle.press("ArrowDown");
    await heightHandle.press("Home");
    await expect.poll(() => logs.evaluate((element) => element.clientHeight)).toBe(oldHeight);
    await expectUiIntegrity(page);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      viewport.height + 1,
    );
  }
}

async function seedAdditionalDebugCandidates(
  page: Page,
  query: string,
  headers: { origin: string },
) {
  const classes = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [
      `com/unopened/Extra${index}.class`,
      buildClassFile({
        className: `com.unopened.Extra${index}`,
        methods: [{ name: "candidate", annotations: [{ type: "Test", values: {} }] }],
      }),
    ]),
  );
  const imported = await page.request.post(`/api/v1/case-sources/jar/import?${query}`, {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    multipart: {
      file: {
        name: "other-candidates.jar",
        mimeType: "application/java-archive",
        buffer: Buffer.from(zipSync(classes)),
      },
    },
  });
  expect([200, 202]).toContain(imported.status());
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/v1/case-definitions?${query}&limit=100`);
        return (await response.json()).items.length;
      },
      { timeout: 30_000 },
    )
    .toBe(61);
  const preview = await page.request.post(`/api/v1/ddt/imports/preview?${query}`, {
    headers,
    multipart: {
      files: {
        name: "other-candidates.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          `CaseID,srNum\n${Array.from({ length: 60 }, (_, index) => `AAA-${index},PAY`).join("\n")}\n`,
        ),
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
        (await (await page.request.get(`/api/v1/ddt/imports/${job.id}?${query}`)).json()).status,
      { timeout: 30_000 },
    )
    .toBe("succeeded");
}

async function screenshotReview(page: Page, name: string) {
  for (const close of await page.locator(".ant-notification-notice-close").all())
    await close.click();
  await expect(page.locator(".ant-notification-notice")).toHaveCount(0);
  const directory = resolve(process.env.AUTOFORGE_UI_SCREENSHOT_DIR ?? ".local/case-debug-ui");
  await mkdir(directory, { recursive: true });
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectUiIntegrity(page);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
      .toBeLessThanOrEqual(1);
    await page.screenshot({
      path: resolve(directory, `${name}-${viewport.width}.png`),
      fullPage: true,
    });
  }
}
