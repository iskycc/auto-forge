export type UploadProgress = {
  loadedBytes: number;
  totalBytes: number;
  percent: number;
};

type UploadRequest = {
  url: string;
  body: XMLHttpRequestBodyInit;
  headers?: Readonly<Record<string, string>>;
  method?: "POST" | "PUT";
  onProgress(progress: UploadProgress): void;
  onUploadComplete?(): void;
};

/**
 * fetch does not expose request-body progress. XHR is intentionally isolated at
 * this browser boundary so feature components can keep using a Response and the
 * repository's existing error parsers.
 */
export function uploadWithProgress(request: UploadRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let uploadCompleteReported = false;

    const reportUploadComplete = (): void => {
      if (uploadCompleteReported) return;
      uploadCompleteReported = true;
      request.onUploadComplete?.();
    };

    xhr.open(request.method ?? "POST", request.url);
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      request.onProgress({
        loadedBytes: event.loaded,
        totalBytes: event.total,
        percent: uploadPercent(event.loaded, event.total),
      });
    };
    xhr.upload.onload = reportUploadComplete;
    xhr.onload = () => {
      reportUploadComplete();
      resolve(
        new Response(xhr.status === 204 || xhr.status === 205 ? null : xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: responseHeaders(xhr.getAllResponseHeaders()),
        }),
      );
    };
    xhr.onerror = () => reject(new Error("上传连接中断，请检查网络后重试。"));
    xhr.onabort = () => reject(new Error("上传已取消。"));
    xhr.ontimeout = () => reject(new Error("上传超时，请检查网络后重试。"));
    xhr.send(request.body);
  });
}

export function uploadPercent(loadedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(loadedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, loadedBytes / totalBytes)) * 100);
}

function responseHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  for (const line of rawHeaders.trim().split(/[\r\n]+/u)) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}
