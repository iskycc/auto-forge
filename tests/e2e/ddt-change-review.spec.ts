import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ensureAdministrator,
  browserJson,
  selectProjectContext,
  acceptSystemDialog,
} from "./support/session";
import {
  createInitializationProject,
  seedInitializationSource,
} from "./support/version-initialization";
import { expectUiIntegrity } from "./support/ui-guard";

test("personal DDT differences require scoped review and preserve private fields and immutable history", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const project = await createInitializationProject(page);
  const source = await seedInitializationSource(page, project.projectId);
  const scope = {
    projectId: project.projectId,
    projectVersionId: source.projectVersionId,
    testStageId: source.testStageId,
  };
  const query = new URLSearchParams(scope).toString();
  const headers = { origin: new URL(page.url()).origin };
  const username = `review-author-${randomUUID().slice(0, 8)}`;
  const password = "ReviewAuthor!Password123";
  const created = await browserJson<{ id: string }>(page, "/api/v1/users", {
    method: "POST",
    body: { username, displayName: "个人调试提交人", password, forcePasswordChange: false },
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
  const author = await page.context().browser()!.newContext({ baseURL: headers.origin });
  try {
    expect(
      (
        await author.request.post("/api/v1/auth/login", { headers, data: { username, password } })
      ).status(),
    ).toBe(200);
    const authorPage = await author.newPage();
    await authorPage.emulateMedia({ reducedMotion: "reduce" });
    const longCaseId = `NEW-${"long-case-identifier-".repeat(15)}`;
    const preview = await author.request.post(`/api/v1/case-debug/ddt/imports/preview?${query}`, {
      headers,
      multipart: {
        files: {
          name: "personal.csv",
          mimeType: "text/csv",
          buffer: Buffer.from(
            `CaseID,srNum,CaseName,amount,account\nPAY-1,PAY,支付回归,88,personal-only\n${longCaseId},PAY,${"长用例名称".repeat(30)},25,new-shared-account\n`,
          ),
        },
      },
    });
    expect(preview.ok()).toBeTruthy();
    const job = (await preview.json()) as { id: string };
    expect(
      (
        await author.request.post(`/api/v1/case-debug/ddt/imports/${job.id}/confirm?${query}`, {
          headers,
          data: { conflictStrategy: "overwrite" },
        })
      ).ok(),
    ).toBeTruthy();
    await expect
      .poll(
        async () =>
          (
            await (
              await author.request.get(`/api/v1/case-debug/ddt/imports/${job.id}?${query}`)
            ).json()
          ).status,
        { timeout: 30_000 },
      )
      .toBe("succeeded");
    await authorPage.goto("/");
    await selectProjectContext(
      authorPage,
      scope.projectId,
      scope.projectVersionId,
      scope.testStageId,
    );
    await authorPage.goto("/case-debug?tab=ddt");
    await authorPage.getByRole("button", { name: "提交变更", exact: true }).click();
    const compose = authorPage.getByRole("dialog", { name: "提交 DDT 变更", exact: true });
    await expect(compose.getByRole("button", { name: "选择字段" })).toHaveCount(2);
    await compose
      .getByLabel("变更标题", { exact: true })
      .fill("更新支付金额及新增回归用例 · 个人调试数据经审核后同步正式版本");
    await compose
      .getByLabel("变更说明（可选）", { exact: true })
      .fill("PAY-1 仅提交 amount；account 继续保留在个人库中。新增用例提交完整内容。");
    await compose
      .getByRole("row")
      .filter({ hasText: "PAY-1" })
      .getByRole("button", { name: "选择字段" })
      .click();
    const fields = authorPage.getByRole("dialog", { name: "选择合入字段", exact: true });
    await expect(fields.getByRole("row").filter({ hasText: "account" })).toContainText(
      "personal-only",
    );
    await fields.getByRole("row").filter({ hasText: "account" }).getByRole("checkbox").uncheck();
    await screenshots(authorPage, "field-selection");
    await fields.getByRole("button", { name: "保存选择", exact: true }).click();
    await compose.getByRole("row").filter({ hasText: longCaseId }).getByRole("checkbox").check();
    await screenshots(authorPage, "submit-differences");
    await compose.getByRole("button", { name: "提交审核（2）", exact: true }).click();
    const history = authorPage.getByRole("dialog", { name: "我的 DDT 变更申请", exact: true });
    await expect(history).toContainText("待审核");
    const requests = (await (await author.request.get(`/api/v1/ddt-changes?${query}`)).json()) as {
      items: { id: string }[];
    };
    expect(requests.items).toHaveLength(1);
    const id = requests.items[0]!.id;
    expect(
      (
        await author.request.post(`/api/v1/ddt-changes/${id}/review?${query}`, {
          headers,
          data: { action: "approve", comment: "unauthorized" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await author.request.get(
          `/api/v1/ddt-changes/${id}?${query.replace(scope.testStageId, "unknown-stage")}`,
        )
      ).ok(),
    ).toBeFalsy();
    const formal = async (caseId: string) =>
      (await (
        await page.request.get(`/api/v1/ddt/cases/${encodeURIComponent(caseId)}?${query}`)
      ).json()) as { data: Record<string, unknown>; revision: number };
    expect(String((await formal("PAY-1")).data.amount)).toBe("12");
    await selectProjectContext(page, scope.projectId, scope.projectVersionId, scope.testStageId);
    await page.goto("/cases?tab=ddt&ddtView=reviews");
    await expect(page.getByRole("heading", { name: "变更审核", exact: true })).toBeVisible();
    await screenshots(page, "review-inbox");
    await page.getByRole("button", { name: "查看审核", exact: true }).click();
    const review = page.getByRole("dialog", { name: "DDT 变更详情", exact: true });
    await review.getByRole("button", { name: /修改 PAY-1/ }).click();
    await expect(review).toContainText("88");
    await expect(review).not.toContainText("personal-only");
    await review.getByRole("button", { name: new RegExp(`新增 ${longCaseId}`) }).click();
    await screenshots(page, "review-differences");
    await review.getByLabel("审核意见（退回时必填）").fill("金额变更已核对；个人账号未合入。");
    await review.getByRole("button", { name: "审核并合入", exact: true }).click();
    await screenshots(page, "approve-confirmation");
    await acceptSystemDialog(page, "确认合入变更", "确认合入");
    await expect(review).toContainText("已合入");
    const updated = await formal("PAY-1");
    expect(String(updated.data.amount)).toBe("88");
    expect(updated.data).not.toHaveProperty("account");
    expect((await formal(longCaseId)).data.CaseID).toBe(longCaseId);
    await review.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
    await page.getByRole("button", { name: "查看详情", exact: true }).click();
    await screenshots(page, "review-dark");
    await review.getByRole("button", { name: "关闭", exact: true }).click();
    await history.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(history).toContainText("已合入");
    expect(
      (await (await author.request.get(`/api/v1/case-debug/ddt/cases/PAY-1?${query}`)).json()).data
        .account,
    ).toBe("personal-only");
    // A new request can be withdrawn by its author without writing the remaining private field.
    const candidate = await (
      await author.request.get(`/api/v1/ddt-changes/candidates/PAY-1?${query}`)
    ).json();
    const withdrawal = await author.request.post(`/api/v1/ddt-changes?${query}`, {
      headers,
      data: {
        id: randomUUID(),
        title: "撤回测试",
        cases: [
          {
            caseId: "PAY-1",
            personalRevision: candidate.personalRevision,
            baseId: candidate.baseId,
            baseRevision: candidate.baseRevision,
          },
        ],
      },
    });
    expect(withdrawal.ok()).toBeTruthy();
    const withdrawnId = (await withdrawal.json()).id as string;
    await history.getByRole("button", { name: "刷新", exact: true }).click();
    await history.getByRole("button", { name: "撤回测试", exact: true }).click();
    const ownDetail = authorPage.getByRole("dialog", { name: "DDT 变更详情", exact: true });
    await expect(ownDetail.getByRole("button", { name: "审核并合入" })).toHaveCount(0);
    await ownDetail.getByRole("button", { name: "撤回申请", exact: true }).click();
    await acceptSystemDialog(authorPage, "确认撤回变更", "确认撤回");
    await expect(ownDetail).toContainText("已撤回");
    expect((await formal("PAY-1")).revision).toBe(updated.revision);
    expect(
      (await (await author.request.get(`/api/v1/ddt-changes/${withdrawnId}?${query}`)).json())
        .status,
    ).toBe("withdrawn");

    // A formal edit after submission must remain intact, and the conflict must stay in the dialog.
    const conflictSubmission = await author.request.post(`/api/v1/ddt-changes?${query}`, {
      headers,
      data: {
        id: randomUUID(),
        title: "并发修改冲突验证",
        cases: [
          {
            caseId: "PAY-1",
            personalRevision: candidate.personalRevision,
            baseId: candidate.baseId,
            baseRevision: candidate.baseRevision,
          },
        ],
      },
    });
    expect(conflictSubmission.ok()).toBeTruthy();
    const currentFormal = await formal("PAY-1");
    expect(
      (
        await page.request.patch(`/api/v1/ddt/cases/PAY-1?${query}`, {
          headers,
          data: {
            expectedRevision: currentFormal.revision,
            data: { ...currentFormal.data, amount: 99 },
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByRole("button", { name: "并发修改冲突验证", exact: true }).click();
    await review.getByRole("button", { name: "审核并合入", exact: true }).click();
    await acceptSystemDialog(page, "确认合入变更", "确认合入");
    await expect(review).toContainText("整单未合入");
    await screenshots(page, "conflict-feedback");
    await review.getByRole("button", { name: "退回修改", exact: true }).click();
    await expect(review).toContainText("退回时请填写原因");
    await screenshots(page, "reject-feedback");
    await review.getByLabel("审核意见（退回时必填）").fill("正式金额已更新，请重新对比后提交。");
    await review.getByRole("button", { name: "退回修改", exact: true }).click();
    await acceptSystemDialog(page, "确认退回变更", "确认退回");
    await expect(review).toContainText("已退回");
    expect(String((await formal("PAY-1")).data.amount)).toBe("99");
  } finally {
    await author.close();
  }
});

test("DDT review layouts handle long content, selection limits, field pagination and filter history", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ensureAdministrator(page);
  const project = await createInitializationProject(page);
  const source = await seedInitializationSource(page, project.projectId);
  const scope = {
    projectId: project.projectId,
    projectVersionId: source.projectVersionId,
    testStageId: source.testStageId,
  };
  const query = new URLSearchParams(scope).toString();
  const headers = { origin: new URL(page.url()).origin };
  const longCaseId = `LONG${"UnbrokenCaseIdentifier".repeat(23)}`;
  const fieldNames = Array.from(
    { length: 25 },
    (_, index) => `field${String(index).padStart(2, "0")}`,
  );
  fieldNames.push(`longField${"WithoutSeparator".repeat(12)}`);
  const caseIds = [
    "PAY-1",
    longCaseId,
    ...Array.from({ length: 51 }, (_, index) => `BULK-${String(index).padStart(3, "0")}`),
  ];
  const csv = [
    ["CaseID", "srNum", "CaseName", "amount", ...fieldNames].join(","),
    ...caseIds.map((id) =>
      [
        id,
        "PAY",
        "多字段回归用例",
        "99",
        ...fieldNames.map((_, index) =>
          index === 0 ? "LongValueWithoutSpaces".repeat(100) : `value-${index}`,
        ),
      ].join(","),
    ),
  ].join("\n");
  const preview = await page.request.post(`/api/v1/case-debug/ddt/imports/preview?${query}`, {
    headers,
    multipart: {
      files: { name: "layout-audit.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
    },
  });
  expect(preview.ok()).toBeTruthy();
  const job = await preview.json();
  expect(
    (
      await page.request.post(`/api/v1/case-debug/ddt/imports/${job.id}/confirm?${query}`, {
        headers,
        data: { conflictStrategy: "overwrite" },
      })
    ).ok(),
  ).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/case-debug/ddt/imports/${job.id}?${query}`)).json())
          .status,
      { timeout: 30_000 },
    )
    .toBe("succeeded");
  await selectProjectContext(page, scope.projectId, scope.projectVersionId, scope.testStageId);
  await page.goto("/case-debug?tab=ddt");
  await expect(page.getByRole("button", { name: "提交变更", exact: true })).toBeVisible();
  await screenshots(page, "debug-entry-light");
  await page.getByRole("button", { name: "提交变更", exact: true }).click();
  const compose = page.getByRole("dialog", { name: "提交 DDT 变更", exact: true });
  const search = compose.getByRole("searchbox", { name: "筛选差异 CaseId" });
  await search.fill(longCaseId);
  await compose.getByRole("button", { name: "查找", exact: true }).click();
  await expect(compose.getByRole("button", { name: "选择字段" })).toHaveCount(1);
  await compose.getByRole("button", { name: "选择字段" }).click();
  const fields = page.getByRole("dialog", { name: "选择合入字段", exact: true });
  await expect(fields).toContainText(longCaseId);
  await screenshots(page, "long-identifier-fields");
  await fields.getByRole("button", { name: "取消", exact: true }).click();
  await search.fill("PAY-1");
  await compose.getByRole("button", { name: "查找", exact: true }).click();
  await expect(compose.getByRole("row").filter({ hasText: "PAY-1" })).toBeVisible();
  await compose.getByRole("button", { name: "选择字段" }).click();
  await expect(fields).toContainText("共 28 个差异字段");
  await fields.getByRole("row").first().getByRole("checkbox").uncheck();
  await fields.getByRole("row").filter({ hasText: "amount" }).getByRole("checkbox").check();
  await fields.locator(".ant-pagination-item-2").click();
  await fields.getByRole("row").first().getByRole("checkbox").uncheck();
  await fields.getByRole("row").filter({ hasText: fieldNames[25]! }).getByRole("checkbox").check();
  await screenshots(page, "field-pagination");
  await fields.getByRole("button", { name: "保存选择", exact: true }).click();
  await expect(compose.getByRole("row").filter({ hasText: "PAY-1" })).toContainText("2 项");
  await compose.getByRole("button", { name: "提交审核（1）", exact: true }).click();
  await expect(compose).toContainText("请填写变更标题");
  await screenshots(page, "missing-title");
  await search.fill("NOT-FOUND");
  await compose.getByRole("button", { name: "查找", exact: true }).click();
  await expect(compose).toContainText("当前这页没有差异");
  await screenshots(page, "empty-differences");
  await search.fill("");
  await compose.getByRole("button", { name: "查找", exact: true }).click();
  await expect(compose.getByRole("button", { name: "选择字段" })).toHaveCount(20);
  await compose.getByRole("button", { name: "清空选择（1）" }).click();
  await compose.getByRole("row").first().getByRole("checkbox").check();
  await expect(compose.getByRole("button", { name: "提交审核（20）" })).toBeEnabled();
  await compose.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(compose).toContainText("第 2 页");
  await compose.getByRole("row").first().getByRole("checkbox").check();
  await expect(compose.getByRole("button", { name: "提交审核（40）" })).toBeEnabled();
  await compose.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(compose.getByRole("button", { name: "选择字段" })).toHaveCount(13);
  await compose.getByRole("row").first().getByRole("checkbox").check();
  await expect(compose.getByRole("button", { name: "提交审核（50）" })).toBeEnabled();
  await screenshots(page, "selection-limit");
  await compose.getByRole("button", { name: "刷新差异", exact: true }).click();
  await expect(compose.getByRole("button", { name: "提交审核（0）" })).toBeDisabled();
  await compose.getByRole("button", { name: "取消", exact: true }).click();

  const candidate = await (
    await page.request.get(`/api/v1/ddt-changes/candidates/PAY-1?${query}`)
  ).json();
  const longTitle = `布局检查${"LongUnbrokenTitle".repeat(8)}`;
  for (let index = 0; index < 23; index++) {
    const id = randomUUID();
    const response = await page.request.post(`/api/v1/ddt-changes?${query}`, {
      headers,
      data: {
        id,
        title: `${String(index).padStart(2, "0")} ${longTitle}`,
        description: "长说明及审核记录。".repeat(200),
        cases: [
          {
            caseId: candidate.caseId,
            personalRevision: candidate.personalRevision,
            baseId: candidate.baseId,
            baseRevision: candidate.baseRevision,
            fields: ["amount"],
          },
        ],
      },
    });
    expect(response.ok()).toBeTruthy();
    if (index < 2)
      expect(
        (
          await page.request.post(`/api/v1/ddt-changes/${id}/review?${query}`, {
            headers,
            data: {
              action: index === 0 ? "reject" : "withdraw",
              comment: "LongReviewComment".repeat(150),
            },
          })
        ).ok(),
      ).toBeTruthy();
  }
  await page.getByRole("button", { name: "我的申请", exact: true }).click();
  const history = page.getByRole("dialog", { name: "我的 DDT 变更申请", exact: true });
  await expect(history).toContainText("本页 20 条");
  await screenshots(page, "own-history-many");
  await history.getByRole("button", { name: "查看详情", exact: true }).first().click();
  const detail = page.getByRole("dialog", { name: "DDT 变更详情", exact: true });
  await expect(detail).toContainText("长说明及审核记录");
  await screenshots(page, "nested-request-detail");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(history).toBeVisible();
  await expect(
    history.getByRole("button", { name: "查看详情", exact: true }).first(),
  ).toBeFocused();
  await history.getByRole("button", { name: "关闭我的 DDT 变更申请", exact: true }).click();
  await page.goto("/cases?tab=ddt&ddtView=reviews");
  const reviews = page.locator('[aria-label="DDT 变更审核"]');
  await expect(reviews).toContainText("本页 20 条");
  await screenshots(page, "review-many-light");
  await reviews.getByRole("combobox", { name: "审核状态" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("已退回", { exact: true }).click();
  await expect(reviews).toContainText("本页 1 条");
  await reviews.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(detail).toContainText("LongReviewComment");
  await detail
    .locator(".action-dialog-body")
    .evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await screenshots(page, "long-review-comment");
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  await reviews.getByRole("combobox", { name: "审核状态" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("已合入", { exact: true }).click();
  await expect(reviews).toContainText("暂无变更申请");
  await screenshots(page, "empty-review-filter");
  await reviews.getByRole("combobox", { name: "审核状态" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("全部状态", { exact: true }).click();
  await expect(reviews).toContainText("本页 20 条");
  await page.getByRole("button", { name: "切换到深色模式", exact: true }).click();
  await screenshots(page, "review-many-dark");
  await reviews.getByRole("combobox", { name: "审核状态" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("待审核", { exact: true }).click();
  await expect(reviews).toContainText("本页 20 条");
  await reviews.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(reviews).toContainText("第 2 页 · 本页 1 条");
  await page.goBack();
  await expect(page).toHaveURL(/reviewStatus=all/);
  await expect(reviews).toContainText("第 1 页 · 本页 20 条");
  await page.goForward();
  await expect(page).toHaveURL(/reviewStatus=pending/);
  await expect(reviews).toContainText("第 1 页 · 本页 20 条");
  await page.reload();
  await expect(reviews).toContainText("第 1 页 · 本页 20 条");
  await reviews.getByRole("combobox", { name: "变更提交范围" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("我的申请", { exact: true }).click();
  await expect(page).toHaveURL(/reviewMine=true/);
  await expect(reviews).toContainText("本页 20 条");
  await page.goto("/case-debug?tab=ddt");
  await screenshots(page, "debug-entry-dark");
  await page.getByRole("button", { name: "提交变更", exact: true }).click();
  await expect(compose.getByRole("button", { name: "选择字段" })).toHaveCount(20);
  await screenshots(page, "compose-dark");
});

async function screenshots(page: Page, name: string) {
  const directory = process.env.AUTOFORGE_UI_SCREENSHOT_DIR;
  for (const width of [1024, 1536]) {
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 960 });
    if (directory) {
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: resolve(directory, `${name}-${width}.png`) });
    }
    await expectUiIntegrity(page);
    for (const body of await page.locator(".ant-modal:visible .action-dialog-body").all())
      expect(
        await body.evaluate((node) => node.scrollWidth - node.clientWidth),
        "dialog horizontal overflow",
      ).toBeLessThanOrEqual(1);
    for (const header of await page.locator(".ant-modal:visible .action-dialog-header").all())
      expect(
        await header.evaluate((node) => node.scrollWidth - node.clientWidth),
        "dialog header horizontal overflow",
      ).toBeLessThanOrEqual(1);
  }
}
