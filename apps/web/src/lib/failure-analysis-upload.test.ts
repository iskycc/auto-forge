import { describe, expect, it } from "vitest";
import {
  FAILURE_ANALYSIS_REMARK_IMAGES_MAXIMUM_BYTES,
  FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES,
} from "@autoforge/contracts";

import {
  readFailureAnalysisCompletion,
  readFailureAnalysisScreenshotBody,
} from "./failure-analysis-upload";

const input = {
  projectId: "project-a",
  analysisIds: ["analysis-a"],
  category: "code_issue_filed",
  ticketReference: "BUG-2048",
  issueDescription: "代码错误",
  remark: "备注文字",
};

describe("bounded analysis screenshot body", () => {
  it("preserves binary bytes and releases the request reader", async () => {
    const bytes = new Uint8Array([0, 137, 80, 78, 71, 255, 13, 10]);
    const request = new Request("http://localhost/proof", { method: "POST", body: bytes });
    expect(await readFailureAnalysisScreenshotBody(request)).toEqual(bytes);
    expect(request.body?.locked).toBe(false);
  });
  it("rejects both declared and streamed oversized images without keeping the reader locked", async () => {
    const declared = new Request("http://localhost/proof", {
      method: "POST",
      headers: { "content-length": String(FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES + 1) },
      body: "small",
    });
    const streamed = new Request("http://localhost/proof", {
      method: "POST",
      body: new Uint8Array(FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES + 1),
    });
    for (const request of [declared, streamed]) {
      await expect(readFailureAnalysisScreenshotBody(request)).rejects.toMatchObject({
        code: "FAILURE_ANALYSIS_SCREENSHOT_SIZE_INVALID",
      });
      expect(request.body?.locked).toBe(false);
    }
  });
});

describe("failure analysis completion upload", () => {
  it("keeps existing JSON clients compatible and reads text with multiple multipart images", async () => {
    const json = await readFailureAnalysisCompletion(
      new Request("http://localhost/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    expect(json).toMatchObject({ input, remarkImages: [] });
    const form = new FormData();
    form.set("input", JSON.stringify(input));
    form.append("remarkImages", new File(["png"], "first.png", { type: "image/png" }));
    form.append("remarkImages", new File(["jpeg"], "second.jpg", { type: "image/jpeg" }));
    const result = await readFailureAnalysisCompletion(
      new Request("http://localhost/api", { method: "POST", body: form }),
    );
    expect(result.input).toMatchObject(input);
    expect(result.remarkImages.map((image) => image.fileName)).toEqual(["first.png", "second.jpg"]);
    expect(new TextDecoder().decode(result.remarkImages[1]!.content)).toBe("jpeg");
  });

  it.each(["json", "multipart"])(
    "preserves the selected inheritance scope in %s and rejects unknown scopes",
    async (encoding) => {
      function request(inheritanceScope: string) {
        const payload = JSON.stringify({
          ...input,
          inheritedFromAnalysisId: "history-a",
          inheritanceScope,
        });
        if (encoding === "json")
          return new Request("http://localhost/api", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
          });
        const form = new FormData();
        form.set("input", payload);
        return new Request("http://localhost/api", { method: "POST", body: form });
      }
      for (const inheritanceScope of ["same_case", "task_recent_batches"]) {
        expect(
          (await readFailureAnalysisCompletion(request(inheritanceScope))).input,
        ).toMatchObject({ inheritedFromAnalysisId: "history-a", inheritanceScope });
      }
      await expect(readFailureAnalysisCompletion(request("all_tasks"))).rejects.toMatchObject({
        name: "ZodError",
      });
    },
  );

  it("rejects invalid form fields and excessive image counts instead of silently discarding them", async () => {
    const form = new FormData();
    form.set("input", JSON.stringify(input));
    form.append("remarkImages", "not a file");
    await expect(
      readFailureAnalysisCompletion(
        new Request("http://localhost/api", { method: "POST", body: form }),
      ),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_SCREENSHOT_SIZE_INVALID" });
    form.delete("remarkImages");
    for (let index = 0; index < 9; index++)
      form.append("remarkImages", new File(["png"], `${index}.png`, { type: "image/png" }));
    await expect(
      readFailureAnalysisCompletion(
        new Request("http://localhost/api", { method: "POST", body: form }),
      ),
    ).rejects.toMatchObject({ code: "FAILURE_ANALYSIS_REMARK_IMAGES_LIMIT" });
    form.set("input", "broken json");
    await expect(
      readFailureAnalysisCompletion(
        new Request("http://localhost/api", { method: "POST", body: form }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_JSON" });
  });

  it("bounds chunked uploads without trusting a content-length header and cancels the stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new Uint8Array(FAILURE_ANALYSIS_REMARK_IMAGES_MAXIMUM_BYTES + 128 * 1024),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body,
      duplex: "half",
    } as RequestInit);
    await expect(readFailureAnalysisCompletion(request)).rejects.toMatchObject({
      code: "FAILURE_ANALYSIS_REMARK_IMAGES_LIMIT",
    });
    expect(cancelled).toBe(true);
  });
});
