import { describe, expect, it } from "vitest";
import { authorizationRouteInventory } from "../../../../tests/e2e/support/authorization-route-inventory";

describe("public task endpoint authorization inventory", () => {
  it("keeps task controls protected while classifying published status and packaged software as public reads", () => {
    const endpoints = new Set(
      authorizationRouteInventory().map(({ method, path }) => `${method} ${path}`),
    );
    expect(endpoints.has("GET /public/case-suites/[suiteId]")).toBe(false);
    expect(endpoints.has("GET /integrations/jenkins/[plugin]/download")).toBe(false);
    for (const operation of [
      "POST /public/case-suites/[suiteId]/executions",
      "POST /public/case-suites/[suiteId]/executions/[batchId]/terminate",
      "GET /case-suites/[suiteId]/execution-link",
      "POST /case-suites/[suiteId]/execution-link",
      "DELETE /case-suites/[suiteId]/execution-link",
    ])
      expect(endpoints.has(operation), operation).toBe(true);
  });
});
