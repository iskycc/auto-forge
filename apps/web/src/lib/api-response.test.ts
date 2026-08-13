import { MAXIMUM_JAR_UPLOAD_BYTES } from "@autoforge/platform-config";
import { DomainError } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { config as proxyConfig } from "../proxy";
import { apiErrorResponse, readJarUpload } from "./api-response";

const MEBIBYTE = 1_048_576;

describe("JAR upload request boundaries", () => {
  it("keeps API uploads outside the Next.js page proxy body limit", () => {
    expect(proxyConfig.matcher.join("\n")).toContain("(?!api(?:/|$)");
    expect(MAXIMUM_JAR_UPLOAD_BYTES).toBe(256 * MEBIBYTE);
  });

  it("rejects a declared oversized multipart request before parsing its body", async () => {
    const request = new Request("http://localhost/api/v1/case-sources/jar/inspect", {
      method: "POST",
      headers: {
        "content-length": String(2 * MEBIBYTE),
        "content-type": "multipart/form-data; boundary=unused",
      },
      body: "unused",
    });

    await expect(readJarUpload(request, MEBIBYTE)).rejects.toMatchObject({
      code: "JAR_TOO_LARGE",
    });
  });

  it("reports malformed multipart uploads as a client error", async () => {
    const request = new Request("http://localhost/api/v1/case-sources/jar/inspect", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=missing" },
      body: "not-a-multipart-body",
    });

    let failure: unknown;
    try {
      await readJarUpload(request, MEBIBYTE);
    } catch (error) {
      failure = error;
    }

    const response = apiErrorResponse(failure, "request-id");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_MULTIPART", requestId: "request-id" },
    });
  });

  it("maps an oversized JAR to HTTP 413", async () => {
    const request = new Request("http://localhost/api/v1/case-sources/jar/inspect", {
      method: "POST",
      headers: {
        "content-length": String(2 * MEBIBYTE),
        "content-type": "multipart/form-data; boundary=unused",
      },
      body: "unused",
    });

    let failure: unknown;
    try {
      await readJarUpload(request, MEBIBYTE);
    } catch (error) {
      failure = error;
    }

    expect(apiErrorResponse(failure).status).toBe(413);
  });

  it("maps an SSH host-key change to a conflict that requires a fresh probe", () => {
    expect(
      apiErrorResponse(
        new DomainError("RUNNER_HOST_KEY_MISMATCH", "The observed host key changed."),
      ).status,
    ).toBe(409);
  });

  it("bounds chunked multipart bodies without trusting Content-Length", async () => {
    const boundary = "autoforge-test";
    const request = new Request("http://localhost/api/v1/case-sources/jar/inspect", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MEBIBYTE));
          controller.enqueue(new Uint8Array(65 * 1_024));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readJarUpload(request, MEBIBYTE)).rejects.toMatchObject({
      code: "JAR_TOO_LARGE",
    });
  });
});
