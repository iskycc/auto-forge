import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authorize: vi.fn(),
  origin: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
  apply: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("./auth", () => ({
  authenticateRequest: mocks.authenticate,
  requireSameOrigin: mocks.origin,
  requestId: () => "association-request",
}));
vi.mock("./ddt-api", () => ({ authorizeDdtScope: mocks.authorize }));
vi.mock("./api-response", async (original) => ({
  ...(await original<typeof import("./api-response")>()),
  readDdtAssociationUpload: mocks.upload,
}));
import { POST } from "../app/api/v1/ddt/association-config/import/route";
const fingerprint = "a".repeat(64);
const preview = {
  fingerprint,
  rowCount: 1,
  issueCount: 0,
  issues: [],
  counts: { range: 1, categories: 0, srCategories: 0, srClasses: 0 },
  samples: [],
};
function request(action = "preview", extra = "") {
  return new Request(`http://localhost/import?action=${action}${extra}`, { method: "POST" });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ user: { id: "admin" } });
  mocks.origin.mockImplementation(() => {});
  mocks.authorize.mockResolvedValue({
    scope: { projectId: "project", projectVersionId: "version", testStageId: "stage" },
    services: {
      ddtAssociations: { read: mocks.read, apply: mocks.apply },
      identityAccess: { recordAuthorizedOperation: mocks.audit },
    },
  });
  mocks.upload.mockResolvedValue({ fileName: "config.xlsx", content: new Uint8Array() });
  mocks.read.mockResolvedValue({ preview, parsed: { rows: [] } });
  mocks.audit.mockResolvedValue(undefined);
});
it("checks same-origin and case.manage before parsing or saving", async () => {
  mocks.origin.mockImplementationOnce(() => {
    throw new DomainError("CSRF_REJECTED", "来源不匹配");
  });
  expect((await POST(request())).status).toBe(403);
  expect(mocks.upload).not.toHaveBeenCalled();
  mocks.authorize.mockRejectedValueOnce(new DomainError("AUTH_FORBIDDEN", "无权限"));
  expect((await POST(request())).status).toBe(403);
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("only previews without applying, rejects issues and stale fingerprints before streaming", async () => {
  expect((await POST(request())).status).toBe(200);
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), "case.manage", expect.any(URL));
  expect((await POST(request("import", `&fingerprint=${"b".repeat(64)}`))).status).toBe(409);
  expect(mocks.apply).not.toHaveBeenCalled();
  mocks.read.mockResolvedValueOnce({ preview: { ...preview, issueCount: 1 } });
  expect((await POST(request("import", `&fingerprint=${fingerprint}`))).status).toBe(422);
  expect(mocks.apply).not.toHaveBeenCalled();
});
it("streams completed progress and audits only after a successful apply", async () => {
  mocks.apply.mockResolvedValue({
    total: 1,
    processed: 1,
    changed: 1,
    unchanged: 0,
    phase: "range",
  });
  const response = await POST(request("import", `&fingerprint=${fingerprint}`));
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  expect(await response.text()).toContain('"type":"completed"');
  expect(mocks.audit).toHaveBeenCalledTimes(2);
});
it("keeps partial progress actionable even when the cause is database contention", async () => {
  mocks.apply.mockRejectedValue(
    new DomainError("DDT_ASSOCIATION_IMPORT_INTERRUPTED", "已处理 2/3 项，其中变更 2 项", {
      cause: Object.assign(new Error("private SQL"), { code: "55P03" }),
      details: { processed: 2 },
    }),
  );
  const response = await POST(request("import", `&fingerprint=${fingerprint}`));
  expect(JSON.parse((await response.text()).trim())).toMatchObject({
    type: "failed",
    code: "DDT_ASSOCIATION_IMPORT_INTERRUPTED",
    processed: 2,
    message: expect.stringContaining("已处理 2/3"),
  });
  expect(mocks.audit).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ action: "ddt_association.import_interrupted" }),
  );
});
