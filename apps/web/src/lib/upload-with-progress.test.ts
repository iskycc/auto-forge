import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadPercent, uploadWithProgress } from "./upload-with-progress";

describe("uploadWithProgress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports request-body progress and preserves the HTTP response", async () => {
    vi.stubGlobal("XMLHttpRequest", SuccessfulRequest);
    const reports: number[] = [];
    let uploadCompleted = 0;

    const response = await uploadWithProgress({
      url: "/upload",
      body: new Blob(["fixture"]),
      onProgress: ({ percent }) => reports.push(percent),
      onUploadComplete: () => {
        uploadCompleted += 1;
      },
    });

    expect(reports).toEqual([50, 100]);
    expect(uploadCompleted).toBe(1);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ id: "asset-1" });
  });
});

describe("uploadPercent", () => {
  it("clamps invalid and out-of-range byte counts", () => {
    expect(uploadPercent(25, 100)).toBe(25);
    expect(uploadPercent(150, 100)).toBe(100);
    expect(uploadPercent(-1, 100)).toBe(0);
    expect(uploadPercent(1, 0)).toBe(0);
  });
});

class SuccessfulRequest {
  readonly upload: {
    onprogress: ((event: ProgressEvent) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  status = 201;
  statusText = "Created";
  responseText = JSON.stringify({ id: "asset-1" });
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(): void {}

  setRequestHeader(): void {}

  getAllResponseHeaders(): string {
    return "content-type: application/json\r\nx-request-id: request-1\r\n";
  }

  send(): void {
    queueMicrotask(() => {
      this.upload.onprogress?.(progressEvent(50, 100));
      this.upload.onprogress?.(progressEvent(100, 100));
      this.upload.onload?.();
      this.onload?.();
    });
  }
}

function progressEvent(loaded: number, total: number): ProgressEvent {
  return { lengthComputable: true, loaded, total } as ProgressEvent;
}
