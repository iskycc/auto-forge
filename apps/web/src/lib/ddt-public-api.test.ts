import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@autoforge/domain";

vi.mock("server-only", () => ({}));
const { getData, getPlatformServices } = vi.hoisted(() => ({
  getData: vi.fn(),
  getPlatformServices: vi.fn(),
}));
vi.mock("./services", () => ({ getPlatformServices }));

import { publicDdtOptions, readPublicDdtCase } from "./ddt-public-api";
import { ddtPublicApiPath, ddtPublicCaseUrl } from "./ddt-public-url";

const scope = { projectId: "project-a", projectVersionId: "version-a", testStageId: "stage-a" };
const base = `http://platform.test${ddtPublicApiPath(scope)}`;

beforeEach(() => {
  vi.resetAllMocks();
  getPlatformServices.mockResolvedValue({ ddtCases: { getData } });
});

describe("anonymous scoped DDT lookup", () => {
  it("returns raw journey data without credentials and never lets query parameters override the scope", async () => {
    const payload = { CaseID: "支付/%2F?# +", srNum: "PAY", 用户旅程: { step1: { amount: 7 } } };
    getData.mockResolvedValue(payload);
    const url = new URL(ddtPublicCaseUrl(base, payload.CaseID));
    url.searchParams.set("projectId", "other-project");
    const response = await readPublicDdtCase(
      new Request(url),
      scope,
      url.searchParams.get("caseId"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(getData).toHaveBeenCalledExactlyOnceWith(scope, payload.CaseID);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("X-Response-Time")).toMatch(/^\d+\.\d+ms$/);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });

  it.each([null, "", "  ", "a".repeat(513)])(
    "rejects invalid CaseID before accessing the database",
    async (caseId) => {
      const response = await readPublicDdtCase(new Request(base), scope, caseId);
      expect(response.status).toBe(400);
      expect(getPlatformServices).not.toHaveBeenCalled();
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    },
  );

  it("rejects incomplete or oversized scope IDs", async () => {
    for (const projectId of ["", "a".repeat(129)]) {
      const response = await readPublicDdtCase(
        new Request(base),
        { ...scope, projectId },
        "CASE-1",
      );
      expect(response.status).toBe(400);
    }
    expect(getData).not.toHaveBeenCalled();
  });

  it("returns a stable, cross-origin readable not-found error", async () => {
    getData.mockRejectedValue(new DomainError("DDT_CASE_NOT_FOUND", "指定的 DDT 用例不存在。"));
    const response = await readPublicDdtCase(new Request(base), scope, "missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "DDT_CASE_NOT_FOUND",
        message: "指定的 DDT 用例不存在。",
        requestId: expect.any(String),
      },
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("allows anonymous read preflight without initializing platform services", () => {
    const response = publicDdtOptions();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
    expect(getPlatformServices).not.toHaveBeenCalled();
  });
});
