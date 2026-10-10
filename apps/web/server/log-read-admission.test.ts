import { describe, expect, it } from "vitest";
import { LogReadAdmission } from "./log-read-admission";

describe("log request admission", () => {
  it.each(["GET", "HEAD"])(
    "counts %s business-ID log pages against the shared read capacity",
    (method) => {
      const admission = new LogReadAdmission(2);
      const publicPage = admission.acquire(method, "/CaseLog?ExecutionId=one&AttemptId=two");
      const api = admission.acquire("GET", "/api/v1/run-attempts/one/logs");
      expect(publicPage.admitted && api.admitted).toBe(true);
      expect(admission.acquire("GET", "/CaseLog?ExecutionId=three").admitted).toBe(false);
      expect(admission.acquire("GET", "/share/attempt-log/legacy-token").admitted).toBe(false);
      expect(admission.acquire("GET", "/CaseLogger").admitted).toBe(true);
      expect(admission.acquire("GET", "/CaseLog/other").admitted).toBe(true);
      expect(admission.acquire("POST", "/CaseLog?ExecutionId=one").admitted).toBe(true);
      expect(admission.acquire("POST", "/api/v1/runner-agents/one/heartbeat").admitted).toBe(true);
      expect(admission.acquire("POST", "/api/v1/runner-agents/one/leases/two/renew").admitted).toBe(
        true,
      );
      expect(admission.acquire("POST", "/api/v1/run-attempts/one/logs").admitted).toBe(true);
      publicPage.release();
      publicPage.release();
      expect(admission.acquire("GET", "/share/attempt-log/legacy-token").admitted).toBe(true);
      expect(admission.acquire("GET", "/CaseLog?ExecutionId=three").admitted).toBe(false);
      api.release();
      expect(admission.acquire("GET", "/CaseLog?ExecutionId=three").admitted).toBe(true);
    },
  );

  it("bounds public SSR and API reads together while admitting pages and log uploads", () => {
    const admission = new LogReadAdmission(2);
    const publicPage = admission.acquire("GET", "/share/attempt-log/token?attempt=one");
    const api = admission.acquire("GET", "/api/v1/run-attempts/one/logs");
    expect(publicPage.admitted && api.admitted).toBe(true);
    expect(admission.acquire("GET", "/share/run/token/attempt/one").admitted).toBe(false);
    expect(admission.acquire("GET", "/cases").admitted).toBe(true);
    expect(admission.acquire("POST", "/api/v1/run-attempts/one/logs").admitted).toBe(true);
    publicPage.release();
    publicPage.release();
    expect(admission.acquire("HEAD", "/share/run/token/attempt/one").admitted).toBe(true);
    expect(admission.acquire("GET", "/api/v1/run-attempts/two/logs").admitted).toBe(false);
    api.release();
    expect(admission.acquire("GET", "/api/v1/run-attempts/two/logs").admitted).toBe(true);
  });
});
